// ---------------------------------------------------------------------------
// Capture route — universal input endpoint
//
// POST /capture          — Partner OS native format
// POST /v1/captures      — Partner Voice compatible (legacy Knowledge Engine)
//
// Both create a CaptureEvent, run AI classification, store to Supabase.
// If Supabase isn't configured, keeps captures in memory (dev fallback).
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import type { KeyStore, GatewayResponse } from '../types.ts'
import { callClaude } from '../providers/claude.ts'
import { callOpenAI } from '../providers/openai.ts'
import { getSupabase } from '../supabase.ts'

// ── In-memory fallback (when Supabase not configured) ──────────────────────
type CaptureRecord = {
  id: string
  type: string
  source: string
  raw: string
  created_at: string
  analysis?: ClassifyResult
}

const memoryStore: CaptureRecord[] = []

// ── Types ──────────────────────────────────────────────────────────────────

type ClassifyResult = {
  category: 'ACTION' | 'NOTE' | 'IDEA' | 'DECISION' | 'COMMITMENT' | 'WAITING' | 'FOLLOW_UP' | 'RISK' | 'PROJECT_UPDATE'
  title: string
  summary: string
  priority_score: number
  priority_reason: string
  project_hint: string | null
  person_hints: string[]
  due_date: string | null
}

// ── AI Classification ──────────────────────────────────────────────────────

async function classifyCapture(raw: string, keys: KeyStore): Promise<ClassifyResult> {
  const claudeKey = keys.claude

  const prompt = `Klasifikuj tento vstup pro osobní produktivitní systém. Odpověz POUZE validním JSON, žádný jiný text.

VSTUP:
"${raw.slice(0, 2000)}"

Vrať JSON v tomto formátu:
{
  "category": "ACTION|NOTE|IDEA|DECISION|COMMITMENT|WAITING|FOLLOW_UP|RISK|PROJECT_UPDATE",
  "title": "krátký popis max 80 znaků",
  "summary": "1-2 věty vysvětlení",
  "priority_score": 0-100,
  "priority_reason": "proč toto číslo (1 věta)",
  "project_hint": "název projektu nebo null",
  "person_hints": ["jméno1", "jméno2"],
  "due_date": "ISO8601 nebo null"
}

Pravidla pro category:
- ACTION: konkrétní věc kterou musím udělat
- COMMITMENT: slib někomu ("pošlu do pátku", "ozvu se")
- WAITING: čekám na někoho
- DECISION: rozhodnutí které bylo nebo musí být přijato
- RISK: hrozba, problém, nebezpečí
- FOLLOW_UP: navazující akce v budoucnu
- PROJECT_UPDATE: aktualizace stavu projektu
- IDEA: nápad bez konkrétní akce
- NOTE: informace k zapamatování

priority_score: 0-100 kde 100 = urgentní+důležité, 0 = nízká priorita`

  try {
    let result: GatewayResponse
    if (claudeKey) {
      result = await callClaude(
        { messages: [{ role: 'user', content: prompt }], model: 'claude-haiku-4-5-20251001', maxTokens: 400, intent: 'fast_summary' },
        claudeKey,
      ).catch(async (e) => {
        // Fallback to OpenAI when Claude credits exhausted
        if (keys.openai) return callOpenAI({ messages: [{ role: 'user', content: prompt }], model: 'gpt-4o-mini', maxTokens: 400 }, keys.openai)
        throw e
      })
    } else if (keys.openai) {
      result = await callOpenAI({ messages: [{ role: 'user', content: prompt }], model: 'gpt-4o-mini', maxTokens: 400 }, keys.openai)
    } else {
      return fallbackClassify(raw)
    }

    const text = (result.content ?? '').trim()
    // Strip markdown code fences if present
    const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    return JSON.parse(json) as ClassifyResult
  } catch (e) {
    console.warn('[capture] AI classification failed, using fallback:', e)
    return fallbackClassify(raw)
  }
}

function fallbackClassify(raw: string): ClassifyResult {
  const lower = raw.toLowerCase()
  let category: ClassifyResult['category'] = 'NOTE'
  let priority_score = 40

  if (/pošlu|udělám|připravím|zavolám|napíšu|odešlu/.test(lower)) {
    category = 'COMMITMENT'; priority_score = 70
  } else if (/musím|udělat|todo|úkol|připomenout/.test(lower)) {
    category = 'ACTION'; priority_score = 60
  } else if (/čekám|čeká|na odpověď|waiting/.test(lower)) {
    category = 'WAITING'; priority_score = 45
  } else if (/rozhodl|rozhodnutí|jdeme|vybrali/.test(lower)) {
    category = 'DECISION'; priority_score = 50
  } else if (/riziko|problém|hrozba|blokuje/.test(lower)) {
    category = 'RISK'; priority_score = 80
  } else if (/nápad|co kdybychom|mohli bychom/.test(lower)) {
    category = 'IDEA'; priority_score = 30
  }

  return {
    category,
    title: raw.slice(0, 80),
    summary: raw.slice(0, 200),
    priority_score,
    priority_reason: 'Automatická klasifikace bez AI',
    project_hint: null,
    person_hints: [],
    due_date: null,
  }
}

// ── Store to Supabase ──────────────────────────────────────────────────────

async function persist(
  type: string,
  source: string,
  raw: string,
  analysis: ClassifyResult,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const id = crypto.randomUUID()
  const sb = getSupabase()

  if (!sb) {
    // Memory fallback
    memoryStore.unshift({ id, type, source, raw, created_at: new Date().toISOString(), analysis })
    if (memoryStore.length > 500) memoryStore.splice(400)
    return id
  }

  // Insert capture event
  await sb.from('capture_events').insert({
    id,
    type,
    source,
    raw,
    created_at: new Date().toISOString(),
  })

  // Insert analysis
  await sb.from('capture_analyses').insert({
    capture_id: id,
    category: analysis.category,
    title: analysis.title,
    summary: analysis.summary,
    priority_score: analysis.priority_score,
    priority_reason: analysis.priority_reason,
    project_hint: analysis.project_hint,
    person_hints: analysis.person_hints,
    due_date: analysis.due_date,
    status: 'inbox',
  })

  // If ACTION or COMMITMENT → also create action record
  if (analysis.category === 'ACTION' || analysis.category === 'COMMITMENT') {
    await sb.from('actions').insert({
      capture_id: id,
      title: analysis.title,
      description: analysis.summary,
      priority_score: analysis.priority_score,
      priority_reason: analysis.priority_reason,
      due_date: analysis.due_date,
      status: 'pending',
    })
  }

  return id
}

// ── Routes ─────────────────────────────────────────────────────────────────

export function captureRoutes(keys: KeyStore) {
  const app = new Hono()

  // GET /capture/inbox — list inbox items
  app.get('/inbox', async (c) => {
    const sb = getSupabase()
    const limit = Number(c.req.query('limit') ?? 50)

    if (!sb) {
      return c.json({ items: memoryStore.slice(0, limit), source: 'memory' })
    }

    const { data, error } = await sb
      .from('capture_analyses')
      .select(`
        id, category, title, summary, priority_score, priority_reason,
        project_hint, person_hints, due_date, status, reviewed, created_at,
        capture_events!inner(id, type, source, raw, created_at)
      `)
      .eq('status', 'inbox')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ items: data ?? [] })
  })

  // POST /capture — native format
  app.post('/', async (c) => {
    let body: {
      type?: string
      source?: string
      text?: string
      content?: string
      metadata?: Record<string, unknown>
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const raw = body.text ?? body.content ?? ''
    if (!raw.trim()) return c.json({ error: 'text or content required' }, 400)

    const type   = body.type ?? 'text'
    const source = body.source ?? 'manual'

    const analysis = await classifyCapture(raw, keys)
    const id       = await persist(type, source, raw, analysis, body.metadata)

    return c.json({ id, analysis }, 201)
  })

  // POST /v1/captures — Partner Voice compatible (Knowledge Engine API)
  // Body: { transcript: string, source?: string, ... }
  app.post('/v1/captures', async (c) => {
    let body: {
      transcript?: string
      text?: string
      content?: string
      source?: string
      captureToKnowledge?: boolean
      metadata?: Record<string, unknown>
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const raw = body.transcript ?? body.text ?? body.content ?? ''
    if (!raw.trim()) return c.json({ success: true, skipped: true })

    const analysis = await classifyCapture(raw, keys)
    const id       = await persist('voice', body.source ?? 'partner_voice', raw, analysis, body.metadata)

    // Partner Voice compatible response format
    return c.json({
      success: true,
      id,
      category: analysis.category,
      title: analysis.title,
      priority_score: analysis.priority_score,
    }, 201)
  })

  // PATCH /capture/:id/status — approve / dismiss / update
  app.patch('/:id/status', async (c) => {
    const id     = c.req.param('id')
    const body   = await c.req.json<{ status: string; reviewed?: boolean }>()
    const sb     = getSupabase()

    if (!sb) {
      const item = memoryStore.find(i => i.id === id)
      if (item) Object.assign(item, body)
      return c.json({ ok: true })
    }

    const { error } = await sb
      .from('capture_analyses')
      .update({ status: body.status, reviewed: body.reviewed ?? true })
      .eq('id', id)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ok: true })
  })

  return app
}

// Export memory store for SSE / polling fallback
export { memoryStore }
