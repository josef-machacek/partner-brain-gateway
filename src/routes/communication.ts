// ---------------------------------------------------------------------------
// Communication Layer — AI klasifikátor e-mailů + SMTP odesílání.
// Outlook personal: imap = outlook.office365.com:993, smtp = smtp-mail.outlook.com:587
// Klasifikace: DECISION / REPLY / ACTION / WAITING / FYI
// Committment Engine: I_OWE_THEM / THEY_OWE_ME
// Lokální storage: ~/.config/partner-voice/comm-events.json
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import * as nodemailer from 'nodemailer'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { collectUnread, collectRecent, loadAccounts, refreshAccess } from './mail.ts'
import { callOllama, DEFAULT_OLLAMA_URL, DEFAULT_OLLAMA_MODEL } from '../providers/ollama.ts'
import type { KeyStore } from '../types.ts'

const DIR  = join(homedir(), '.config', 'partner-voice')
const COMM = join(DIR, 'comm-events.json')
const SMTP_CFG = join(DIR, 'smtp-accounts.json')

// ── Types ────────────────────────────────────────────────────────────────────
export type CommCategory = 'DECISION' | 'REPLY' | 'ACTION' | 'WAITING' | 'FYI'
export interface Commitment {
  type: 'I_OWE_THEM' | 'THEY_OWE_ME'
  what: string
  who: string
  deadline: string | null
  done: boolean
}
export interface CommEvent {
  id: string               // `${account}-${uid}`
  account: string
  uid: number
  from: string
  fromName: string
  subject: string
  date: string
  preview: string
  category: CommCategory
  urgent: boolean
  summary: string          // Co se stalo (1-2 věty)
  context: string          // Relevantní projekt/firma
  options: string[]        // Možné akce (pro DECISION)
  recommendation: string   // Partner doporučuje
  deadline: string | null
  draftReply: string | null
  actionTitle: string | null
  commitments: Commitment[]
  dismissed: boolean
  classifiedAt: string
}

// ── Storage ───────────────────────────────────────────────────────────────────
function readEvents(): CommEvent[] {
  try { return JSON.parse(readFileSync(COMM, 'utf8')) as CommEvent[] } catch { return [] }
}
function saveEvents(events: CommEvent[]): void {
  mkdirSync(dirname(COMM), { recursive: true })
  writeFileSync(COMM, JSON.stringify(events, null, 2))
}
function upsertEvent(ev: CommEvent): void {
  const all = readEvents()
  const idx = all.findIndex(e => e.id === ev.id)
  if (idx >= 0) all[idx] = ev; else all.unshift(ev)
  // Drž max 500 událostí
  saveEvents(all.slice(0, 500))
}

// ── SMTP config ───────────────────────────────────────────────────────────────
interface SmtpAccount { email: string; host: string; port: number; password?: string; refreshToken?: string; type: 'password' | 'google-oauth' }
function loadSmtpAccounts(): SmtpAccount[] {
  try { return JSON.parse(readFileSync(SMTP_CFG, 'utf8')) as SmtpAccount[] } catch { return [] }
}
function saveSmtpAccounts(list: SmtpAccount[]): void {
  mkdirSync(dirname(SMTP_CFG), { recursive: true })
  writeFileSync(SMTP_CFG, JSON.stringify(list, null, 2), { mode: 0o600 })
}

function detectSmtp(email: string): { host: string; port: number } {
  const d = (email.split('@')[1] || '').toLowerCase()
  if (d === 'gmail.com' || d === 'googlemail.com') return { host: 'smtp.gmail.com', port: 587 }
  if (d === 'outlook.com' || d === 'hotmail.com' || d === 'live.com' || d === 'msn.com') return { host: 'smtp-mail.outlook.com', port: 587 }
  if (d === 'icloud.com' || d === 'me.com' || d === 'mac.com') return { host: 'smtp.mail.me.com', port: 587 }
  if (d === 'seznam.cz') return { host: 'smtp.seznam.cz', port: 587 }
  if (d === 'yahoo.com') return { host: 'smtp.mail.yahoo.com', port: 587 }
  return { host: `smtp.${d}`, port: 587 }
}

async function sendSmtp(fromAccount: string, to: string, subject: string, text: string, inReplyTo?: string): Promise<void> {
  // Zkus SMTP config; pokud chybí, zkopíruj z IMAP účtu
  let smtpList = loadSmtpAccounts()
  let cfg = smtpList.find(a => a.email === fromAccount)
  if (!cfg) {
    const imapAcc = loadAccounts().find(a => a.email === fromAccount)
    if (!imapAcc) throw new Error(`Účet ${fromAccount} není nakonfigurovaný`)
    const det = detectSmtp(fromAccount)
    cfg = { email: fromAccount, host: det.host, port: det.port, password: imapAcc.password, type: imapAcc.type, refreshToken: imapAcc.refreshToken }
    smtpList = smtpList.filter(a => a.email !== fromAccount)
    smtpList.push(cfg)
    saveSmtpAccounts(smtpList)
  }
  let auth: nodemailer.TransportOptions & { auth: { type?: string; user: string; pass?: string; accessToken?: string } }
  if (cfg.type === 'google-oauth') {
    const token = await refreshAccess(cfg.refreshToken!)
    auth = { host: cfg.host, port: cfg.port, secure: false, auth: { type: 'OAuth2', user: cfg.email, accessToken: token } }
  } else {
    auth = { host: cfg.host, port: cfg.port, secure: false, auth: { user: cfg.email, pass: cfg.password! } }
  }
  const transport = nodemailer.createTransport(auth as Parameters<typeof nodemailer.createTransport>[0])
  const msg: nodemailer.SendMailOptions = { from: cfg.email, to, subject, text }
  if (inReplyTo) { msg.inReplyTo = inReplyTo; msg.references = inReplyTo }
  await transport.sendMail(msg)
}

// ── AI klasifikátor ───────────────────────────────────────────────────────────
const CLASSIFY_SYSTEM = `Jsi AI vrstva Partnera — osobního OS Josefa Machacka (CEO/zakladatel: Mitogena Health, TRT klinika, CEO OS, EasyMedic, Partner OS a další).
Zpracuješ příchozí e-maily a klasifikuješ každý do JEDNÉ kategorie:

DECISION — někdo potřebuje Josefovo rozhodnutí. Musí být z e-mailu jasné, co rozhodnout.
REPLY — e-mail vyžaduje odpověď, ale ne zásadní rozhodnutí (potvrzení, info, koordinace).
ACTION — z e-mailu vzniká konkrétní úkol pro Josefa nebo jeho tým.
WAITING — Josef/Partner někdy požádal o něco a toto je odpověď/splnění toho závazku.
FYI — informace, bez akce. Newsletter, notifikace, potvrzení, spam.

Pro každý mail vrať JSON objekt:
{
  "index": 0,
  "category": "DECISION"|"REPLY"|"ACTION"|"WAITING"|"FYI",
  "urgent": true|false,
  "summary": "Co se přesně stalo — 1 věta česky",
  "context": "Název projektu/firmy nebo 'Osobní'",
  "options": ["možnost A", "možnost B"],   // prázdné pole pokud ne DECISION
  "recommendation": "Partner doporučuje: ...",  // 1 věta, nebo "" pokud FYI
  "deadline": "YYYY-MM-DD nebo null",
  "draftReply": "Celý text navrhované odpovědi česky, nebo null",  // pro REPLY
  "actionTitle": "Imperativ v češtině nebo null",  // pro ACTION
  "commitments": [
    {"type": "I_OWE_THEM"|"THEY_OWE_ME", "what": "co", "who": "kdo", "deadline": "datum nebo null"}
  ]
}

Odpověz VÝHRADNĚ JSON polem, jeden objekt na mail, stejné pořadí jako vstup. Žádný text navíc.
draftReply piš v přátelské profesionální češtině, přirozené, bez zbytečných formalit.`

function parseClassification(text: string): Array<Record<string, unknown>> {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const s = t.indexOf('['); const e = t.lastIndexOf(']')
  if (s >= 0 && e > s) t = t.slice(s, e + 1)
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : [] } catch { return [] }
}

async function classifyMails(mails: Awaited<ReturnType<typeof collectUnread>>, keys: KeyStore): Promise<CommEvent[]> {
  if (!mails.length) return []
  const list = mails.map((m, i) =>
    `[${i}] Od: ${m.fromName || m.from} <${m.from}>\nPředmět: ${m.subject}\nDatum: ${m.date}` +
    (m.preview ? `\nÚryvek: ${m.preview}` : '')).join('\n\n---\n\n')

  let raw = ''
  if (keys.claude) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': keys.claude, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8192, system: CLASSIFY_SYSTEM,
        messages: [{ role: 'user', content: list }] }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!r.ok) {
      const err = await r.text()
      console.error('[classify] Claude API error:', r.status, err)
      throw new Error(`Claude API ${r.status}: ${err}`)
    }
    const j = await r.json() as { content?: Array<{ text: string }> }
    raw = j.content?.[0]?.text ?? ''
    console.log(`[classify] Claude OK, raw length: ${raw.length}`)
  } else if (keys.openai) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.openai}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: CLASSIFY_SYSTEM }, { role: 'user', content: list }] }),
    })
    const j = await r.json() as { choices?: Array<{ message: { content: string } }> }
    raw = j.choices?.[0]?.message.content ?? ''
  } else {
    // Ollama — lokální model, bez tokenů, bez klíče
    const ollamaBase = keys.ollamaUrl ?? DEFAULT_OLLAMA_URL
    const ollamaModel = keys.ollamaModel ?? DEFAULT_OLLAMA_MODEL
    try {
      const res = await callOllama(
        { messages: [{ role: 'user', content: list }], system: CLASSIFY_SYSTEM, maxTokens: 8192, temperature: 0.1 },
        ollamaBase,
        ollamaModel,
      )
      raw = res.content
      console.log(`[classify] Ollama OK (${ollamaModel}), raw length: ${raw.length}`)
    } catch (e) {
      console.warn('[classify] Ollama nedostupné, padám na heuristiku:', String(e))
    }
  }

  if (!raw) {
    // Heuristika bez AI — žádný provider nebyl dostupný
    return mails.map(m => ({
      id: `${m.account}-${m.uid}`,
      account: m.account, uid: m.uid, from: m.from, fromName: m.fromName,
      subject: m.subject, date: m.date, preview: m.preview,
      category: 'REPLY' as CommCategory,
      urgent: false, summary: m.subject, context: 'Nezařazeno',
      options: [], recommendation: '', deadline: null, draftReply: null,
      actionTitle: null, commitments: [], dismissed: false,
      classifiedAt: new Date().toISOString(),
    }))
  }

  const results = parseClassification(raw)
  return mails.map((m, i) => {
    const r = results.find(x => Number(x['index']) === i) ?? {}
    return {
      id: `${m.account}-${m.uid}`,
      account: m.account, uid: m.uid, from: m.from, fromName: m.fromName,
      subject: m.subject, date: m.date, preview: m.preview,
      category: (['DECISION','REPLY','ACTION','WAITING','FYI'].includes(String(r['category'])) ? r['category'] : 'FYI') as CommCategory,
      urgent: Boolean(r['urgent']),
      summary: String(r['summary'] ?? m.subject),
      context: String(r['context'] ?? ''),
      options: Array.isArray(r['options']) ? r['options'].map(String) : [],
      recommendation: String(r['recommendation'] ?? ''),
      deadline: r['deadline'] != null && r['deadline'] !== 'null' ? String(r['deadline']) : null,
      draftReply: r['draftReply'] != null && r['draftReply'] !== 'null' ? String(r['draftReply']) : null,
      actionTitle: r['actionTitle'] != null && r['actionTitle'] !== 'null' ? String(r['actionTitle']) : null,
      commitments: Array.isArray(r['commitments']) ? (r['commitments'] as Array<Record<string, unknown>>).map(c => ({
        type: c['type'] === 'I_OWE_THEM' ? 'I_OWE_THEM' : 'THEY_OWE_ME' as 'I_OWE_THEM' | 'THEY_OWE_ME',
        what: String(c['what'] ?? ''), who: String(c['who'] ?? ''),
        deadline: c['deadline'] != null && c['deadline'] !== 'null' ? String(c['deadline']) : null,
        done: false,
      })) : [],
      dismissed: false,
      classifiedAt: new Date().toISOString(),
    }
  })
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function communicationRoutes(keys: KeyStore) {
  const app = new Hono()

  // GET /communication/inbox — načte maily, zkusí z cache, jinak klasifikuje
  app.get('/inbox', async c => {
    try {
      const refresh = c.req.query('refresh') === '1'
      const stored = readEvents().filter(e => !e.dismissed)

      const freshCutoff = Date.now() - 5 * 60 * 1000
      const allFresh = stored.length > 0 && stored.every(e => new Date(e.classifiedAt).getTime() > freshCutoff)
      if (allFresh && !refresh) return c.json({ events: stored, cached: true })

      // Používáme collectRecent (ne jen unseen) — Outlook mohl vše označit jako přečtené
      const mails = await collectRecent(30)
      if (!mails.length) return c.json({ events: stored, cached: false, noNew: true })

      const storedIds = new Set(stored.map(e => e.id))
      const newMails = mails.filter(m => !storedIds.has(`${m.account}-${m.uid}`))
      if (!newMails.length) return c.json({ events: stored, cached: true })

      // Klasifikuj po dávkách po 15 aby AI call nebyl příliš velký
      const BATCH = 15
      for (let i = 0; i < newMails.length; i += BATCH) {
        const batch = newMails.slice(i, i + BATCH)
        const classified = await classifyMails(batch, keys)
        classified.forEach(upsertEvent)
      }

      const all = readEvents().filter(e => !e.dismissed)
      return c.json({ events: all, cached: false })
    } catch (err) {
      console.error('[communication/inbox] error:', err)
      return c.json({ error: String(err), events: [], cached: false }, 500)
    }
  })

  // POST /communication/reply — odešle odpověď přes SMTP
  app.post('/reply', async c => {
    const body = await c.req.json() as { eventId?: string; text?: string; to?: string; subject?: string; inReplyTo?: string }
    const { eventId, text, to, subject } = body
    if (!text || !to) return c.json({ error: 'text a to jsou povinné' }, 400)

    // Zjisti, ze kterého účtu poslat
    const events = readEvents()
    const ev = events.find(e => e.id === eventId)
    const fromAccount = ev?.account ?? loadAccounts()[0]?.email
    if (!fromAccount) return c.json({ error: 'Žádný e-mailový účet' }, 400)

    try {
      await sendSmtp(fromAccount, to, subject ?? `Re: ${ev?.subject ?? ''}`, text, body.inReplyTo)
      // Označ event jako vyřízený
      if (ev) { ev.dismissed = true; upsertEvent(ev) }
      return c.json({ ok: true })
    } catch (e) { return c.json({ error: String(e) }, 500) }
  })

  // POST /communication/dismiss — skryj event (FYI nebo vyřízené)
  app.post('/dismiss', async c => {
    const { ids } = await c.req.json() as { ids?: string[] }
    if (!ids?.length) return c.json({ error: 'ids povinné' }, 400)
    const events = readEvents()
    ids.forEach(id => { const ev = events.find(e => e.id === id); if (ev) ev.dismissed = true })
    saveEvents(events)
    return c.json({ ok: true })
  })

  // POST /communication/commitment/done — označ závazek jako splněný
  app.post('/commitment/done', async c => {
    const { eventId, commitmentIndex } = await c.req.json() as { eventId?: string; commitmentIndex?: number }
    const events = readEvents()
    const ev = events.find(e => e.id === eventId)
    if (ev && ev.commitments[commitmentIndex ?? -1]) {
      ev.commitments[commitmentIndex!].done = true
      saveEvents(events)
    }
    return c.json({ ok: true })
  })

  // GET /communication/commitments — všechny aktivní závazky
  app.get('/commitments', c => {
    const events = readEvents()
    const active = events.flatMap(ev =>
      ev.commitments
        .map((cm, i) => ({ ...cm, eventId: ev.id, commitmentIndex: i, subject: ev.subject, from: ev.fromName || ev.from }))
        .filter(cm => !cm.done))
    return c.json({ commitments: active })
  })

  // GET /communication/stats — přehled pro briefing
  app.get('/stats', c => {
    const events = readEvents().filter(e => !e.dismissed)
    const byCategory = { DECISION: 0, REPLY: 0, ACTION: 0, WAITING: 0, FYI: 0 }
    events.forEach(e => { byCategory[e.category]++ })
    const overdue = events.filter(e => e.deadline && new Date(e.deadline) < new Date()).length
    return c.json({ total: events.length, byCategory, overdue })
  })

  // SMTP: přidat/aktualizovat SMTP heslo pro účet
  app.post('/smtp', async c => {
    const body = await c.req.json() as { email?: string; password?: string; host?: string; port?: number }
    const email = (body.email ?? '').trim(); const password = (body.password ?? '').trim()
    if (!email || !password) return c.json({ error: 'email a password povinné' }, 400)
    const det = detectSmtp(email)
    const cfg: SmtpAccount = { email, host: body.host ?? det.host, port: body.port ?? det.port, password, type: 'password' }
    const list = loadSmtpAccounts().filter(a => a.email !== email); list.push(cfg)
    saveSmtpAccounts(list)
    // Otestuj
    try {
      const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: false, auth: { user: email, pass: password } })
      await t.verify()
      return c.json({ ok: true, host: cfg.host })
    } catch (e) { return c.json({ error: `SMTP test selhal: ${String(e)}` }, 401) }
  })

  // ── Shrnutí porady — Ollama / Claude / OpenAI ────────────────────────────────
  // POST /communication/summarize  { transcript: string, context?: string }
  // → { summary, actionItems: [{text, deadline?}] }
  app.post('/summarize', async c => {
    const body = await c.req.json() as { transcript?: string; context?: string }
    const { transcript, context } = body
    if (!transcript || transcript.trim().length < 20)
      return c.json({ error: 'transcript příliš krátký' }, 400)

    const SYSTEM = `Jsi asistent pro zpracování porad. Přijmeš přepis porady a vrátíš VÝHRADNĚ JSON (bez markdown):
{"summary":"stručné shrnutí 3–5 vět česky","actionItems":[{"text":"imperativ česky","deadline":"YYYY-MM-DD nebo null"}]}
Žádný jiný text. Deadline vyplň jen pokud je explicitně zmíněn v přepisu.`
    const prompt = context
      ? `Kontext: ${context}\n\nPŘEPIS:\n${transcript}`
      : `PŘEPIS:\n${transcript}`

    let raw = ''
    try {
      if (keys.claude) {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': keys.claude, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2048, system: SYSTEM,
            messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(60_000),
        })
        const j = await r.json() as { content?: Array<{ text: string }> }
        raw = j.content?.[0]?.text ?? ''
      } else if (keys.openai) {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${keys.openai}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] }),
        })
        const j = await r.json() as { choices?: Array<{ message: { content: string } }> }
        raw = j.choices?.[0]?.message.content ?? ''
      } else {
        const res = await callOllama(
          { messages: [{ role: 'user', content: prompt }], system: SYSTEM, maxTokens: 2048, temperature: 0.2 },
          keys.ollamaUrl ?? DEFAULT_OLLAMA_URL,
          keys.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
        )
        raw = res.content
      }
    } catch (e) {
      return c.json({ error: `AI selhal: ${String(e)}` }, 502)
    }

    // Parse JSON — strip markdown fences if any
    const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const s = t.indexOf('{'); const e = t.lastIndexOf('}')
    try {
      const parsed = JSON.parse(s >= 0 && e > s ? t.slice(s, e + 1) : t) as { summary: string; actionItems: { text: string; deadline?: string }[] }
      return c.json({ summary: parsed.summary ?? '', actionItems: parsed.actionItems ?? [] })
    } catch {
      return c.json({ summary: raw.slice(0, 500), actionItems: [] })
    }
  })

  // ── Briefing — agregovaný ranní přehled ──────────────────────────────────────
  // GET /communication/briefing?days=1
  // → { greeting, date, decisions[], urgent[], todayEvents[], waitingOn[], stats }
  app.get('/briefing', async c => {
    const days = Math.min(7, Math.max(1, Number(c.req.query('days') || 1)))

    // Paralelně: inbox + kalendář
    const [eventsResult, inboxResult] = await Promise.allSettled([
      fetch(`http://localhost:${process.env['GATEWAY_PORT'] ?? 4000}/calendar/events?days=${days}`)
        .then(r => r.json() as Promise<{ events: Array<{ id: string; title: string; start: string; end: string; allDay: boolean; location?: string }> }>)
        .catch(() => ({ events: [] as Array<{ id: string; title: string; start: string; end: string; allDay: boolean; location?: string }> })),
      Promise.resolve({ events: readEvents().filter(e => !e.dismissed) }),
    ])

    const calEvents = eventsResult.status === 'fulfilled' ? eventsResult.value.events : []
    const commEvents = inboxResult.status === 'fulfilled' ? inboxResult.value.events : []

    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const todayEnd   = new Date(todayStart.getTime() + 86_400_000)

    const todayEvents = calEvents.filter(ev => {
      const s = new Date(ev.start)
      return s >= todayStart && s < todayEnd
    })

    const decisions = commEvents.filter(e => e.category === 'DECISION')
    const urgent    = commEvents.filter(e => e.urgent && e.category !== 'DECISION')
    const waitingOn = commEvents.filter(e => e.category === 'WAITING')
    const replies   = commEvents.filter(e => e.category === 'REPLY')

    const overdue = commEvents.filter(e => e.deadline && new Date(e.deadline) < now)

    const h = now.getHours()
    const greeting = h < 10 ? 'Dobré ráno' : h < 17 ? 'Dobrý den' : 'Dobrý večer'

    return c.json({
      greeting,
      date: now.toISOString(),
      decisions,
      urgent,
      replies: replies.slice(0, 5),
      todayEvents,
      waitingOn: waitingOn.slice(0, 5),
      overdue,
      stats: {
        total: commEvents.length,
        decisions: decisions.length,
        urgent: urgent.length,
        replies: replies.length,
        waiting: waitingOn.length,
        overdue: overdue.length,
        todayMeetings: todayEvents.length,
      },
    })
  })

  return app
}
