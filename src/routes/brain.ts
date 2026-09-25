// ---------------------------------------------------------------------------
// Brain — Partner Brain Phase 1 + 2
//
// POST /brain/meeting              — transkript porady → bilateral commitments
// GET  /brain/commitments          — list (?direction=inbound|outbound&status=pending)
// PATCH /brain/commitments/:id     — update status (done|dismissed)
// POST /brain/commitments/:id/urge   — vygeneruj urgování zprávu
// POST /brain/commitments/:id/remind — nastav reminder (scheduled_at)
// GET  /brain/today                — denní agenda: splatné dnes + overdue + co urgovat
// GET  /brain/people               — list osob
// GET  /brain/people/:id           — profil + závazky + historia
// POST /brain/search               — semantic search nad brain_items
// POST /brain/embed                — ulož text do brain (s embeddingem)
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import type { KeyStore } from '../types.ts'
import { callClaude } from '../providers/claude.ts'
import { callOpenAI } from '../providers/openai.ts'
import { getSupabase } from '../supabase.ts'

// ── Types ──────────────────────────────────────────────────────────────────

interface ExtractedCommitment {
  person: string
  description: string
  deadline: string | null        // ISO date or null
  direction: 'outbound' | 'inbound'
  urgency: number                // 0–100
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function callAI(prompt: string, keys: KeyStore, maxTokens = 600): Promise<string> {
  const msgs = [{ role: 'user' as const, content: prompt }]

  // Try Claude first, fall through to OpenAI on any failure
  if (keys.claude) {
    try {
      const r = await callClaude(
        { messages: msgs, model: 'claude-haiku-4-5-20251001', maxTokens },
        keys.claude,
      )
      return (r.content ?? '').trim()
    } catch (e) {
      console.warn('[brain] Claude failed, trying OpenAI fallback:', (e as Error).message?.slice(0, 80))
    }
  }

  if (keys.openai) {
    try {
      const r = await callOpenAI(
        { messages: msgs, model: 'gpt-4o-mini', maxTokens },
        keys.openai,
      )
      return (r.content ?? '').trim()
    } catch (e) {
      console.warn('[brain] OpenAI failed:', (e as Error).message?.slice(0, 80))
    }
  }

  return ''
}

function parseJSON<T>(text: string): T | null {
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    return JSON.parse(clean) as T
  } catch {
    return null
  }
}

// ── Embedding helper ───────────────────────────────────────────────────────

async function embed(text: string, openaiKey: string): Promise<number[] | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
    })
    const data = await res.json() as { data?: Array<{ embedding: number[] }> }
    return data.data?.[0]?.embedding ?? null
  } catch (e) {
    console.warn('[brain] embed error:', e)
    return null
  }
}

// ── Extract commitments from transcript ───────────────────────────────────

async function extractCommitmentsFromTranscript(
  transcript: string,
  keys: KeyStore,
): Promise<ExtractedCommitment[]> {
  const prompt = `Z níže uvedeného přepisu porady extrahuj VŠECHNY závazky.
Uživatel = "já" (osoba která používá systém).

Pro každý závazek urči:
- person: jméno osoby (druhá strana závazku)
- description: co přesně bylo slíbeno (1 věta, přesný popis)
- deadline: datum nebo null (ISO formát YYYY-MM-DD)
- direction: "outbound" = JÁ jsem slíbil/a | "inbound" = DRUHÁ OSOBA slíbila mně
- urgency: 0-100 (100 = kritické/dnes, 50 = běžné, 20 = nízká priorita)

Vrať POUZE JSON pole, žádný jiný text:
[
  {
    "person": "Martin",
    "description": "pošle cenovou nabídku do pátku",
    "deadline": "2026-09-26",
    "direction": "inbound",
    "urgency": 70
  }
]

Pokud nejsou žádné závazky, vrať prázdné pole [].

PŘEPIS:
${transcript.slice(0, 6000)}`

  const raw = await callAI(prompt, keys, 1200)
  return parseJSON<ExtractedCommitment[]>(raw) ?? []
}

// ── Resolve or create person ───────────────────────────────────────────────

async function resolvePersonId(name: string, userId: string): Promise<string | null> {
  if (!name?.trim()) return null
  const sb = getSupabase()
  if (!sb) return null

  const normalized = name.trim().toLowerCase()

  // Try exact match first
  const { data: exact } = await sb
    .from('people')
    .select('id, name, aliases')
    .eq('user_id', userId)
    .ilike('name', name.trim())
    .limit(1)
    .single()

  if (exact) return exact.id

  // Check aliases
  const { data: all } = await sb
    .from('people')
    .select('id, name, aliases')
    .eq('user_id', userId)

  for (const p of (all ?? [])) {
    const aliases: string[] = p.aliases ?? []
    if (aliases.some((a: string) => a.toLowerCase() === normalized)) return p.id
    if ((p.name as string).toLowerCase().includes(normalized) || normalized.includes((p.name as string).toLowerCase())) {
      return p.id
    }
  }

  // Create new person
  const { data: created } = await sb
    .from('people')
    .insert({ user_id: userId, name: name.trim() })
    .select('id')
    .single()

  return created?.id ?? null
}

// ── Routes ─────────────────────────────────────────────────────────────────

export function brainRoutes(keys: KeyStore) {
  const app = new Hono()

  // POST /brain/meeting — transkript → bilateral commitments + brain storage
  app.post('/meeting', async (c) => {
    let body: { transcript: string; capture_id?: string; title?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    if (!body.transcript?.trim()) return c.json({ error: 'transcript required' }, 400)

    const userId = 'local'
    const sb = getSupabase()

    // 1. Extract commitments
    const extracted = await extractCommitmentsFromTranscript(body.transcript, keys)

    // 2. Embed transcript and store in brain_items
    let embeddingStored = false
    if (sb && keys.openai) {
      // Chunk transcript into ~300-word pieces
      const words = body.transcript.split(/\s+/)
      const chunkSize = 300
      const overlap = 50
      const chunks: string[] = []
      for (let i = 0; i < words.length; i += chunkSize - overlap) {
        chunks.push(words.slice(i, i + chunkSize).join(' '))
        if (i + chunkSize >= words.length) break
      }

      for (const chunk of chunks) {
        const vector = await embed(chunk, keys.openai)
        if (vector) {
          const { error: insErr } = await sb.from('brain_items').insert({
            user_id: userId,
            capture_id: body.capture_id ?? null,
            content: chunk,
            embedding: `[${vector.join(',')}]`,
            metadata: {
              source: 'meeting',
              title: body.title ?? 'Porada',
              people: extracted.map(e => e.person),
            },
          })
          if (insErr) console.warn('[brain] brain_items insert failed:', insErr.message)
          else embeddingStored = true
        }
      }
    }

    // 3. Persist commitments
    const saved: unknown[] = []
    if (sb) {
      for (const c of extracted) {
        const personId = await resolvePersonId(c.person, userId)

        const { data } = await sb.from('commitments').insert({
          user_id:     userId,
          capture_id:  body.capture_id ?? null,
          title:       c.description,
          to_person:   c.person,
          person_id:   personId,
          due_date:    c.deadline ?? null,
          direction:   c.direction,
          urgency:     c.urgency,
          status:      'pending',
          source:      'meeting',
        }).select().single()

        if (data) {
          saved.push(data)
          // Schedule reminder if deadline exists
          if (c.deadline) {
            const deadline = new Date(c.deadline)
            const twoDaysBefore = new Date(deadline.getTime() - 2 * 24 * 60 * 60 * 1000)
            const now = new Date()
            if (twoDaysBefore > now) {
              await sb.from('reminders').insert({
                user_id: userId,
                commitment_id: (data as { id: string }).id,
                scheduled_at: twoDaysBefore.toISOString(),
                type: 'deadline_approaching',
              })
            }
            if (deadline > now) {
              await sb.from('reminders').insert({
                user_id: userId,
                commitment_id: (data as { id: string }).id,
                scheduled_at: deadline.toISOString(),
                type: 'overdue',
              })
            }
          }
        }
      }
    }

    return c.json({
      commitments_extracted: extracted.length,
      commitments_saved: saved.length,
      brain_embedded: embeddingStored,
      commitments: sb ? saved : extracted,
    }, 201)
  })

  // GET /brain/commitments
  app.get('/commitments', async (c) => {
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    const direction = c.req.query('direction')
    const status    = c.req.query('status') ?? 'pending'
    const limit     = Number(c.req.query('limit') ?? 50)

    let q = sb
      .from('commitments')
      .select(`
        id, title, to_person, direction, status, urgency,
        due_date, created_at, completed_at, source, capture_id,
        person_id,
        people(id, name)
      `)
      .eq('user_id', 'local')
      .neq('status', 'dismissed')
      .order('urgency', { ascending: false })
      .limit(limit)

    if (direction) q = q.eq('direction', direction)
    if (status !== 'all') q = q.eq('status', status)

    const { data, error } = await q
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ commitments: data ?? [], total: data?.length ?? 0 })
  })

  // PATCH /brain/commitments/:id
  app.patch('/commitments/:id', async (c) => {
    const id = c.req.param('id')
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    let body: { status: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const updates: Record<string, unknown> = {
      status: body.status,
      updated_at: new Date().toISOString(),
    }
    if (body.status === 'done') updates.completed_at = new Date().toISOString()

    const { error } = await sb.from('commitments').update(updates).eq('id', id)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ok: true })
  })

  // POST /brain/commitments/:id/urge — vygeneruj zprávu pro urgování
  app.post('/commitments/:id/urge', async (c) => {
    const id = c.req.param('id')
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    const { data: commitment } = await sb
      .from('commitments')
      .select('*, people(name)')
      .eq('id', id)
      .single()

    if (!commitment) return c.json({ error: 'Not found' }, 404)

    const daysLate = commitment.due_date
      ? Math.floor((Date.now() - new Date(commitment.due_date).getTime()) / 86400000)
      : null

    const prompt = `Napiš krátkou, přátelskou ale důraznou zprávu pro urgování závazku.

Osoba: ${(commitment.people as { name: string } | null)?.name ?? commitment.to_person ?? 'kolega'}
Závazek: ${commitment.title}
${commitment.due_date ? `Deadline byl: ${commitment.due_date}` : ''}
${daysLate !== null && daysLate > 0 ? `Zpoždění: ${daysLate} dní` : ''}

Zpráva by měla být:
- max 3 věty
- přátelská, ne agresivní
- konkrétní (zmiňuje co se čeká)
- česky

Vrať POUZE text zprávy, žádný komentář.`

    const message = await callAI(prompt, keys, 200)
    return c.json({ suggested_message: message, commitment })
  })

  // POST /brain/commitments/:id/remind — nastav nebo aktualizuj reminder
  app.post('/commitments/:id/remind', async (c) => {
    const id = c.req.param('id')
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    let body: { scheduled_at: string; type?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    if (!body.scheduled_at) return c.json({ error: 'scheduled_at required' }, 400)

    const type = body.type ?? 'follow_up'
    const validTypes = ['deadline_approaching', 'overdue', 'follow_up']
    if (!validTypes.includes(type)) return c.json({ error: 'invalid type' }, 400)

    // Upsert: pokud existuje nesplněný reminder pro tento závazek, aktualizuj ho
    const { data: existing } = await sb
      .from('reminders')
      .select('id')
      .eq('commitment_id', id)
      .is('sent_at', null)
      .limit(1)
      .maybeSingle()

    let result
    if (existing) {
      result = await sb
        .from('reminders')
        .update({ scheduled_at: body.scheduled_at, type })
        .eq('id', existing.id)
        .select('id, scheduled_at, type')
        .single()
    } else {
      result = await sb
        .from('reminders')
        .insert({ user_id: 'local', commitment_id: id, scheduled_at: body.scheduled_at, type })
        .select('id, scheduled_at, type')
        .single()
    }

    if (result.error) return c.json({ error: result.error.message }, 500)
    return c.json({ reminder: result.data }, existing ? 200 : 201)
  })

  // GET /brain/today — denní agenda: závazky splatné dnes + overdue + co urgovat
  app.get('/today', async (c) => {
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date()
    todayEnd.setHours(23, 59, 59, 999)

    const [{ data: dueToday }, { data: overdue }, { data: toUrge }, { data: remindersToday }] =
      await Promise.all([
        // Závazky outbound splatné dnes
        sb.from('commitments')
          .select('id, title, to_person, direction, status, urgency, due_date, people(id, name)')
          .eq('user_id', 'local')
          .eq('direction', 'outbound')
          .eq('status', 'pending')
          .gte('due_date', todayStart.toISOString().slice(0, 10))
          .lte('due_date', todayEnd.toISOString().slice(0, 10))
          .order('urgency', { ascending: false }),

        // Overdue závazky obou směrů
        sb.from('commitments')
          .select('id, title, to_person, direction, status, urgency, due_date, people(id, name)')
          .eq('user_id', 'local')
          .eq('status', 'pending')
          .lt('due_date', todayStart.toISOString().slice(0, 10))
          .order('urgency', { ascending: false })
          .limit(10),

        // Inbound závazky starší 7 dní bez aktivity → urgovat
        sb.from('commitments')
          .select('id, title, to_person, direction, status, urgency, due_date, created_at, people(id, name)')
          .eq('user_id', 'local')
          .eq('direction', 'inbound')
          .eq('status', 'pending')
          .lt('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
          .order('urgency', { ascending: false })
          .limit(5),

        // Dnešní remindery (scheduled_at <= now + 24h, sent_at IS NULL)
        sb.from('reminders')
          .select('id, commitment_id, scheduled_at, type, commitments(id, title, to_person, direction, people(id, name))')
          .eq('user_id', 'local')
          .is('sent_at', null)
          .lte('scheduled_at', todayEnd.toISOString())
          .order('scheduled_at'),
      ])

    return c.json({
      due_today:       dueToday       ?? [],
      overdue:         overdue        ?? [],
      urge_candidates: toUrge         ?? [],
      reminders:       remindersToday ?? [],
      generated_at:    new Date().toISOString(),
    })
  })

  // PATCH /brain/reminders/:id/sent — označ reminder jako odeslaný
  app.patch('/reminders/:id/sent', async (c) => {
    const id = c.req.param('id')
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    const { error } = await sb
      .from('reminders')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', id)
      .is('sent_at', null)

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ok: true })
  })

  // GET /brain/people
  app.get('/people', async (c) => {
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    const { data, error } = await sb
      .from('people')
      .select('id, name, aliases, notes, last_contact, open_commitments, created_at')
      .eq('user_id', 'local')
      .order('name')

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ people: data ?? [] })
  })

  // GET /brain/people/:id — profil + závazky
  app.get('/people/:id', async (c) => {
    const personId = c.req.param('id')
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    const [{ data: person }, { data: commitments }] = await Promise.all([
      sb.from('people').select('*').eq('id', personId).single(),
      sb.from('commitments')
        .select('id, title, direction, status, urgency, due_date, created_at, completed_at')
        .eq('user_id', 'local')
        .eq('person_id', personId)
        .order('created_at', { ascending: false })
        .limit(50),
    ])

    if (!person) return c.json({ error: 'Person not found' }, 404)

    const all = commitments ?? []
    const total = all.length
    const done  = all.filter((c: { status: string }) => c.status === 'done').length

    return c.json({
      person,
      commitments: all,
      stats: {
        total,
        done,
        pending:          all.filter((c: { status: string }) => c.status === 'pending').length,
        fulfillment_rate: total > 0 ? Math.round((done / total) * 100) : null,
      },
    })
  })

  // POST /brain/search — semantic search
  app.post('/search', async (c) => {
    let body: { query: string; limit?: number }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    if (!body.query?.trim()) return c.json({ error: 'query required' }, 400)

    const sb     = getSupabase()
    const limit  = body.limit ?? 5

    // Embed the query and do vector search
    if (sb && keys.openai) {
      const vector = await embed(body.query, keys.openai)
      if (vector) {
        const { data } = await sb.rpc('match_brain_items', {
          query_embedding: vector,
          match_count: limit,
          match_threshold: 0.65,
        }) as { data: Array<{ id: string; content: string; metadata: Record<string, unknown>; similarity: number }> | null }

        if (data?.length) {
          // Generate answer from top results
          const context = data.map(r => r.content).join('\n\n---\n\n')
          const answerPrompt = `Jsi Partner Brain. Odpověz na otázku uživatele na základě kontextu z jeho poznámek a porad.
Odpovídej česky, stručně a konkrétně.

KONTEXT:
${context}

OTÁZKA: ${body.query}`

          const answer = await callAI(answerPrompt, keys, 500)
          return c.json({ answer, sources: data, method: 'vector' })
        }
      }
    }

    // Fallback: keyword search přes capture_analyses
    if (sb) {
      const { data: keyword } = await sb
        .from('capture_analyses')
        .select('title, summary, category, created_at')
        .or(`title.ilike.%${body.query}%,summary.ilike.%${body.query}%`)
        .order('created_at', { ascending: false })
        .limit(limit)

      const context = (keyword ?? [])
        .map((r: { category: string; title: string; summary: string | null }) => `[${r.category}] ${r.title}: ${r.summary ?? ''}`)
        .join('\n')

      const answerPrompt = `Jsi Partner Brain. Odpověz na otázku uživatele.
KONTEXT: ${context || '(žádné relevantní záznamy)'}
OTÁZKA: ${body.query}`

      const answer = await callAI(answerPrompt, keys, 400)
      return c.json({ answer, sources: keyword ?? [], method: 'keyword' })
    }

    return c.json({ answer: 'Supabase není nakonfigurováno.', sources: [], method: 'none' })
  })

  // POST /brain/embed — přidej libovolný text do brain_items
  app.post('/embed', async (c) => {
    let body: { text: string; capture_id?: string; metadata?: Record<string, unknown> }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    if (!body.text?.trim()) return c.json({ error: 'text required' }, 400)

    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)
    if (!keys.openai) return c.json({ error: 'OpenAI key required for embeddings' }, 503)

    const vector = await embed(body.text, keys.openai)
    if (!vector) return c.json({ error: 'Embedding failed' }, 502)

    const { data, error } = await sb.from('brain_items').insert({
      user_id:    'local',
      capture_id: body.capture_id ?? null,
      content:    body.text,
      embedding:  `[${vector.join(',')}]`,
      metadata:   body.metadata ?? {},
    }).select('id').single()

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ id: (data as { id: string }).id }, 201)
  })

  // POST /brain/push-token — ulož Expo push token pro odesílání notifikací
  app.post('/push-token', async (c) => {
    let body: { token: string; platform?: string }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    if (!body.token?.trim()) return c.json({ error: 'token required' }, 400)

    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    const { error } = await sb.from('push_tokens').upsert({
      token:      body.token,
      platform:   body.platform ?? 'ios',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'token' })

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ok: true })
  })

  // POST /brain/push/send-reminders — pošli push notifikace pro dnešní závazky
  // Voláno cron johem nebo manuálně
  app.post('/push/send-reminders', async (c) => {
    const sb = getSupabase()
    if (!sb) return c.json({ error: 'Supabase not configured' }, 503)

    const today = new Date().toISOString().slice(0, 10)

    // Načti splatné závazky
    const { data: commitments } = await sb
      .from('commitments')
      .select('id, title, to_person, direction, due_date')
      .in('status', ['pending'])
      .lte('due_date', today)
      .limit(20)

    if (!commitments?.length) return c.json({ sent: 0 })

    // Načti push tokeny
    const { data: tokens } = await sb.from('push_tokens').select('token')
    if (!tokens?.length) return c.json({ sent: 0, note: 'no push tokens registered' })

    const messages = tokens.flatMap(({ token }: { token: string }) =>
      commitments.map((cm: { id: string; title: string; to_person: string | null; direction: string; due_date: string | null }) => ({
        to:    token,
        title: cm.direction === 'outbound' ? `⏰ Ty: ${cm.title}` : `📩 ${cm.to_person ?? 'Někdo'}: ${cm.title}`,
        body:  cm.due_date ? `Splatnost: ${cm.due_date}` : 'Bez termínu',
        data:  { commitmentId: cm.id },
      }))
    )

    // Expo Push API
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Accept-Encoding': 'gzip' },
      body:    JSON.stringify(messages),
    })
    const result = await res.json() as unknown
    return c.json({ sent: messages.length, result })
  })

  return app
}
