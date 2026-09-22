// ---------------------------------------------------------------------------
// Priority Engine — rescore + Daily Mission generator
//
// GET  /priority/actions        — all pending actions sorted by score
// POST /priority/rescore        — re-run AI scoring on all inbox items
// GET  /priority/daily-mission  — generate today's TOP 3 + capacity plan
// POST /priority/daily-mission  — save today's mission
// GET  /priority/daily-mission/today — fetch saved mission for today
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import type { KeyStore } from '../types.ts'
import { callOpenAI } from '../providers/openai.ts'
import { callClaude } from '../providers/claude.ts'
import { getSupabase } from '../supabase.ts'

async function callAI(prompt: string, keys: KeyStore, maxTokens = 800): Promise<string> {
  try {
    if (keys.claude) {
      const r = await callClaude(
        { messages: [{ role: 'user', content: prompt }], model: 'claude-haiku-4-5-20251001', maxTokens },
        keys.claude,
      ).catch(async () => {
        if (keys.openai) return callOpenAI({ messages: [{ role: 'user', content: prompt }], model: 'gpt-4o-mini', maxTokens }, keys.openai)
        throw new Error('No AI provider')
      })
      return (r.content ?? '').trim()
    }
    if (keys.openai) {
      const r = await callOpenAI({ messages: [{ role: 'user', content: prompt }], model: 'gpt-4o-mini', maxTokens }, keys.openai)
      return (r.content ?? '').trim()
    }
  } catch (e) {
    console.warn('[priority] AI failed:', e)
  }
  return ''
}

// In-memory fallback for actions when Supabase not available
let memActions: { id: string; title: string; priority_score: number; due_date: string | null; status: string }[] = []

export function priorityRoutes(keys: KeyStore) {
  const app = new Hono()

  // ── GET /priority/actions — sorted pending actions ─────────────────────────
  app.get('/actions', async (c) => {
    const sb = getSupabase()
    if (!sb) {
      return c.json({ actions: memActions.filter(a => a.status === 'pending').sort((a, b) => b.priority_score - a.priority_score) })
    }

    const { data, error } = await sb
      .from('capture_analyses')
      .select('id, category, title, summary, priority_score, priority_reason, project_hint, person_hints, due_date, status, created_at')
      .in('status', ['inbox', 'active'])
      .order('priority_score', { ascending: false })
      .limit(100)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ actions: data ?? [] })
  })

  // ── POST /priority/rescore — re-score items AI ─────────────────────────────
  app.post('/rescore', async (c) => {
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase required for rescore' }, 400)

    const { data: items } = await sb
      .from('capture_analyses')
      .select('id, title, summary, category, due_date')
      .eq('status', 'inbox')
      .limit(20)

    if (!items?.length) return c.json({ rescored: 0 })

    const today = new Date().toISOString().slice(0, 10)
    const prompt = `Dnes je ${today}. Přehodnoť priority těchto položek a vrať JSON pole.

Každá položka: { "id": "...", "priority_score": 0-100, "priority_reason": "proč (1 věta)" }

Pravidla:
- Deadline dnes nebo zítra: +30 bodů
- RISK nebo blokující: score min 75
- COMMITMENT s jménem osoby: score min 65
- Starší než 7 dní bez akce: -10 bodů

Položky:
${JSON.stringify(items.map(i => ({ id: i.id, title: i.title, category: i.category, due_date: i.due_date })))}

Odpověz POUZE validním JSON polem, žádný jiný text.`

    const text = await callAI(prompt, keys, 600)
    try {
      const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      const scores = JSON.parse(json) as { id: string; priority_score: number; priority_reason: string }[]

      let rescored = 0
      for (const s of scores) {
        const { error } = await sb.from('capture_analyses').update({
          priority_score: s.priority_score,
          priority_reason: s.priority_reason,
        }).eq('id', s.id)
        if (!error) rescored++
      }
      return c.json({ rescored })
    } catch (e) {
      return c.json({ error: 'AI scoring failed', detail: String(e) }, 500)
    }
  })

  // ── GET /priority/daily-mission — generate today's mission ────────────────
  app.get('/daily-mission', async (c) => {
    const today = new Date().toISOString().slice(0, 10)
    const sb = getSupabase()

    // Check if we have a saved mission for today
    if (sb) {
      const { data: saved } = await sb.from('daily_missions').select('*').eq('date', today).single()
      if (saved) return c.json({ mission: saved, source: 'saved' })
    }

    // Fetch top pending items
    let items: { title: string; category: string; priority_score: number; due_date: string | null; project_hint: string | null }[] = []
    if (sb) {
      const { data } = await sb
        .from('capture_analyses')
        .select('title, category, priority_score, due_date, project_hint')
        .in('status', ['inbox', 'active'])
        .order('priority_score', { ascending: false })
        .limit(20)
      items = data ?? []
    }

    if (!items.length) {
      return c.json({
        mission: {
          date: today,
          top3: [
            { rank: 1, title: 'Žádné položky v inbox', reason: 'Zachyť první věc přes Capture', category: 'NOTE', priority_score: 0 },
          ],
          capacity_pct: 80,
          notes: 'Inbox je prázdný. Zachyť první úkoly a pak zregeneruj.',
        },
        source: 'empty',
      })
    }

    const prompt = `Dnes je ${today}. Vytvoř denní misi — TOP 3 nejdůležitější věci pro dnešek.

Dostupné položky (seřazeny dle priority):
${JSON.stringify(items)}

Vrať JSON:
{
  "top3": [
    { "rank": 1, "title": "...", "reason": "proč právě dnes (1 věta)", "category": "...", "priority_score": 0-100 },
    { "rank": 2, ... },
    { "rank": 3, ... }
  ],
  "capacity_pct": 70-90,
  "notes": "1-2 věty o dnešním dni a fokus"
}

Pravidla výběru:
- Deadline dnes/zítra má prioritu
- Max 1 RISK v TOP3 (jinak je den příliš defenzivní)
- Vyvážit akce vs. závazky vs. rozhodnutí
- capacity_pct: 70 = nabitý den, 90 = lehký den

Odpověz POUZE validním JSON, žádný jiný text.`

    const text = await callAI(prompt, keys, 500)
    try {
      const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      const parsed = JSON.parse(json)
      return c.json({
        mission: { date: today, ...parsed },
        source: 'generated',
      })
    } catch {
      // Fallback: just return top 3 by score
      const top3 = items.slice(0, 3).map((item, i) => ({
        rank: i + 1,
        title: item.title,
        reason: `Priorita ${item.priority_score}/100`,
        category: item.category,
        priority_score: item.priority_score,
      }))
      return c.json({ mission: { date: today, top3, capacity_pct: 80, notes: '' }, source: 'fallback' })
    }
  })

  // ── POST /priority/daily-mission — save mission ────────────────────────────
  app.post('/daily-mission', async (c) => {
    const body = await c.req.json<{ date?: string; top3: unknown[]; capacity_pct?: number; notes?: string }>()
    const date = body.date ?? new Date().toISOString().slice(0, 10)
    const sb = getSupabase()

    if (!sb) return c.json({ ok: true, stored: 'memory' })

    const { error } = await sb.from('daily_missions').upsert({
      date,
      top3: body.top3,
      capacity_pct: body.capacity_pct ?? 80,
      notes: body.notes ?? '',
    })

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ok: true })
  })

  return app
}
