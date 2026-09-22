// ---------------------------------------------------------------------------
// Ask Partner — RAG-lite query over captures + context
//
// POST /ask  { question: string }
//   → { answer: string, sources: CaptureRef[] }
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import type { KeyStore } from '../types.ts'
import { callOpenAI } from '../providers/openai.ts'
import { callClaude } from '../providers/claude.ts'
import { getSupabase } from '../supabase.ts'
import { memoryStore } from './capture.ts'

async function callAI(systemPrompt: string, userMsg: string, keys: KeyStore): Promise<string> {
  const msgs = [{ role: 'user' as const, content: userMsg }]
  try {
    if (keys.claude) {
      const r = await callClaude(
        { messages: msgs, system: systemPrompt, model: 'claude-haiku-4-5-20251001', maxTokens: 800 },
        keys.claude,
      ).catch(async () => {
        if (keys.openai) return callOpenAI({ messages: msgs, system: systemPrompt, model: 'gpt-4o-mini', maxTokens: 800 }, keys.openai)
        throw new Error('no ai')
      })
      return (r.content ?? '').trim()
    }
    if (keys.openai) {
      const r = await callOpenAI({ messages: msgs, system: systemPrompt, model: 'gpt-4o-mini', maxTokens: 800 }, keys.openai)
      return (r.content ?? '').trim()
    }
  } catch (e) {
    console.warn('[ask] AI error:', e)
  }
  return 'Omlouvám se, AI není dostupná.'
}

export function askRoutes(keys: KeyStore) {
  const app = new Hono()

  app.post('/', async (c) => {
    let body: { question: string; limit?: number }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    if (!body.question?.trim()) return c.json({ error: 'question required' }, 400)

    const limit = body.limit ?? 30
    const sb = getSupabase()

    // Fetch recent captures as context
    type ContextItem = { title: string; category: string; summary: string | null; created_at: string }
    let context: ContextItem[] = []

    if (sb) {
      const { data } = await sb
        .from('capture_analyses')
        .select('title, category, summary, created_at')
        .order('created_at', { ascending: false })
        .limit(limit)
      context = (data ?? []) as ContextItem[]
    } else {
      context = memoryStore.slice(0, limit).map(item => ({
        title: item.analysis?.title ?? item.raw.slice(0, 80),
        category: item.analysis?.category ?? 'NOTE',
        summary: item.analysis?.summary ?? null,
        created_at: item.created_at,
      }))
    }

    const today = new Date().toISOString().slice(0, 10)
    const systemPrompt = `Jsi Partner — osobní AI asistent. Dnes je ${today}.
Máš přístup k zachyceným poznámkám, závazkům a akcím uživatele.
Odpovídej česky, stručně a konkrétně. Pokud informace nemáš, řekni to.`

    const contextStr = context.length
      ? `Zachycené položky (od nejnovějších):\n${context.map(i =>
          `[${i.category}] ${i.title}${i.summary && i.summary !== i.title ? ` — ${i.summary}` : ''}`
        ).join('\n')}`
      : 'Zatím žádné zachycené položky.'

    const userMsg = `${contextStr}\n\nOtázka: ${body.question}`
    const answer = await callAI(systemPrompt, userMsg, keys)

    return c.json({ answer, sources_count: context.length })
  })

  return app
}
