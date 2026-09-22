// ---------------------------------------------------------------------------
// Partner agenti — reálná exekuce, žádná simulace. První agent: Inbox triage.
// Načte nepřečtené maily (mail bridge), nechá LLM roztřídit a navrhnout úkoly.
// Vytváření úkolů dělá frontend (workspace store je v appce) — tady jen
// poctivá klasifikace na reálných datech.
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import { route } from '../router.ts'
import type { KeyStore } from '../types.ts'
import { collectUnread } from './mail.ts'

interface Triaged {
  uid: number; account: string; from: string; fromName: string; subject: string; date: string
  important: boolean; category: string; reason: string; needsReply: boolean; taskTitle: string | null
}

const SYSTEM = `Jsi inbox agent Partnera — osobního OS Josefa Machacka, který je CEO/zakladatel několika firem (Mitogena Health, TRT klinika, další).
Roztřídíš jeho nepřečtené e-maily. U KAŽDÉHO rozhodni střízlivě a bez nadhodnocování:
- important: TRUE jen když jde o věc, která reálně vyžaduje jeho pozornost nebo akci (od člověka, klient, dodavatel, faktura, schůzka, rozhodnutí). FALSE pro newslettery, marketing, automatické notifikace systémů, potvrzení, spam.
- category: přesně jedno z: akce | schuzka | financ | klient | info | newsletter | notifikace | spam
- reason: JEDNA krátká věta česky, proč jsi tak rozhodl.
- needsReply: true jen když se od Josefa čeká odpověď.
- taskTitle: pokud important A je z toho konkrétní úkol, krátký název v imperativu česky (např. "Odpovědět Kučerovi na nabídku"). Jinak null.

Odpověz VÝHRADNĚ validním JSON polem, jeden objekt na e-mail ve STEJNÉM pořadí a počtu jako vstup:
[{"index":0,"important":true,"category":"klient","reason":"…","needsReply":true,"taskTitle":"…"}, …]
Žádný text okolo, žádné markdown fence.`

function parseJsonArray(text: string): Array<Record<string, unknown>> {
  let t = text.trim()
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = t.indexOf('['); const end = t.lastIndexOf(']')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : [] } catch { return [] }
}

export function agentRoutes(keys: KeyStore) {
  const app = new Hono()

  // POST /agents/inbox/triage → roztřídí nepřečtené maily
  app.post('/inbox/triage', async c => {
    const body = await c.req.json().catch(() => ({})) as { limit?: number }
    const mails = await collectUnread(Math.min(40, body.limit || 25))
    if (!mails.length) return c.json({ triaged: [], count: 0, unread: 0 })

    const list = mails.map((m, i) =>
      `[${i}] Od: ${m.fromName || m.from} <${m.from}> | Předmět: ${m.subject}` +
      (m.preview ? `\n     Úryvek: ${m.preview}` : '')).join('\n\n')

    let cls: Array<Record<string, unknown>> = []
    try {
      const res = await route({
        provider: 'claude', system: SYSTEM,
        messages: [{ role: 'user', content: list }],
        maxTokens: 2000, temperature: 0, intent: 'inbox-triage', module: 'agents',
      }, keys)
      cls = parseJsonArray(res.content)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
    }

    const triaged: Triaged[] = mails.map((m, i) => {
      const r = cls.find(x => Number(x.index) === i) ?? {}
      return {
        uid: m.uid, account: m.account, from: m.from, fromName: m.fromName, subject: m.subject, date: m.date,
        important: !!r.important,
        category: typeof r.category === 'string' ? r.category : 'info',
        reason: typeof r.reason === 'string' ? r.reason : '',
        needsReply: !!r.needsReply,
        taskTitle: typeof r.taskTitle === 'string' && r.taskTitle.trim() ? r.taskTitle.trim() : null,
      }
    })

    return c.json({
      triaged, count: triaged.length, unread: mails.length,
      important: triaged.filter(t => t.important).length,
    })
  })

  return app
}
