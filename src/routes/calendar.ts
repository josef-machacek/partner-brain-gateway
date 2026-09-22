// ---------------------------------------------------------------------------
// Kalendáře — Google Calendar API (přes OAuth token z mail.ts) + iCloud CalDAV.
// Sdílí účty i OAuth konfiguraci s mailem. Údaje zůstávají lokálně.
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import { loadAccounts, refreshAccess, type MailAccount } from './mail.ts'

export interface CalEvent {
  account: string
  id:      string
  title:   string
  start:   string   // ISO
  end:     string   // ISO
  allDay:  boolean
  location?: string
}

let cache: { at: number; events: CalEvent[] } | null = null
const CACHE_MS = 120_000

// ── Google Calendar ──────────────────────────────────────────────────────────
async function googleEvents(acc: MailAccount, timeMin: string, timeMax: string): Promise<CalEvent[]> {
  const token = await refreshAccess(acc.refreshToken!)
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({
    timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '30',
  })
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const j = await r.json() as { items?: Array<Record<string, unknown>>; error?: { message?: string } }
  if (!r.ok) throw new Error(j.error?.message || `google calendar ${r.status}`)
  return (j.items || []).map(ev => {
    const s = ev.start as { dateTime?: string; date?: string } | undefined
    const e = ev.end as { dateTime?: string; date?: string } | undefined
    const allDay = !!(s?.date && !s?.dateTime)
    return {
      account: acc.email,
      id: String(ev.id ?? Math.random()),
      title: String(ev.summary ?? '(bez názvu)'),
      start: s?.dateTime || (s?.date ? `${s.date}T00:00:00` : ''),
      end: e?.dateTime || (e?.date ? `${e.date}T00:00:00` : ''),
      allDay,
      location: ev.location ? String(ev.location) : undefined,
    }
  }).filter(ev => ev.start)
}

// ── iCloud CalDAV ────────────────────────────────────────────────────────────
async function dav(url: string, method: string, body: string, acc: MailAccount, depth = '0'): Promise<string> {
  const auth = 'Basic ' + Buffer.from(`${acc.email}:${acc.password}`).toString('base64')
  const r = await fetch(url, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8', Depth: depth },
    body, redirect: 'follow',
  })
  if (r.status >= 400) throw new Error(`caldav ${method} ${r.status}`)
  return await r.text()
}
function firstMatch(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<[a-z0-9]*:?${tag}[^>]*>([^<]+)</`, 'i'))
  return m ? m[1].trim() : null
}
function allHrefs(xml: string): string[] {
  return [...xml.matchAll(/<[a-z0-9]*:?href[^>]*>([^<]+)<\/[a-z0-9]*:?href>/gi)].map(m => m[1].trim())
}

async function icloudEvents(acc: MailAccount, timeMin: string, timeMax: string): Promise<CalEvent[]> {
  const base = 'https://caldav.icloud.com'
  // 1) principal
  const p = await dav(base + '/', 'PROPFIND',
    `<A:propfind xmlns:A="DAV:"><A:prop><A:current-user-principal/></A:prop></A:propfind>`, acc, '0')
  const principal = allHrefs(p).find(h => h.includes('principal')) || firstMatch(p, 'href')
  if (!principal) throw new Error('icloud: principal nenalezen')
  // 2) calendar-home-set
  const home = await dav(base + principal, 'PROPFIND',
    `<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><A:prop><C:calendar-home-set/></A:prop></A:propfind>`, acc, '0')
  const homeHref = allHrefs(home).find(h => h.includes('/calendars')) || ''
  if (!homeHref) throw new Error('icloud: calendar-home nenalezen')
  const homeUrl = homeHref.startsWith('http') ? homeHref : base + homeHref
  const homeOrigin = new URL(homeUrl).origin
  // 3) seznam kalendářů (přeskoč svátky/jmeniny/narozeniny — v pracovním Flow šum)
  const list = await dav(homeUrl, 'PROPFIND',
    `<A:propfind xmlns:A="DAV:"><A:prop><A:resourcetype/><A:displayname/></A:prop></A:propfind>`, acc, '1')
  const NOISE = /sv[aá]tk|j?menin|narozenin|holiday|birthday|svatky|siri|us holiday|czech|reminders/i
  const calHrefs = [...list.matchAll(/<[a-z0-9]*:?response[^>]*>([\s\S]*?)<\/[a-z0-9]*:?response>/gi)]
    .filter(m => /calendar/i.test(m[1]) && !/<[a-z0-9]*:?resourcetype\s*\/>/i.test(m[1]))
    .filter(m => !NOISE.test(firstMatch(m[1], 'displayname') || ''))
    .map(m => allHrefs(m[1])[0]).filter(Boolean)
  // 4) REPORT každý kalendář (expand = server rozvine opakující se události na reálná data)
  const out: CalEvent[] = []
  const fmt = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/T/, 'T').slice(0, 15) + 'Z'
  for (const href of calHrefs) {
    const calUrl = href.startsWith('http') ? href : homeOrigin + href
    let xml: string
    try {
      xml = await dav(calUrl, 'REPORT',
        `<C:calendar-query xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><A:prop><C:calendar-data><C:expand start="${fmt(timeMin)}" end="${fmt(timeMax)}"/></C:calendar-data></A:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${fmt(timeMin)}" end="${fmt(timeMax)}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
        acc, '1')
    } catch { continue }
    for (const block of xml.split(/BEGIN:VEVENT/).slice(1)) {
      const ics = 'BEGIN:VEVENT' + block.split('END:VEVENT')[0]
      const g = (k: string) => { const m = ics.match(new RegExp(`${k}[^:\\n]*:([^\\r\\n]+)`)); return m ? m[1].trim() : '' }
      const dtStart = g('DTSTART'); if (!dtStart) continue
      const allDay = /VALUE=DATE/.test(ics.match(new RegExp('DTSTART[^:\\n]*'))?.[0] || '') || dtStart.length === 8
      out.push({
        account: acc.email, id: g('UID') || Math.random().toString(),
        title: g('SUMMARY') || '(bez názvu)',
        start: parseIcsDate(dtStart), end: parseIcsDate(g('DTEND') || dtStart),
        allDay, location: g('LOCATION') || undefined,
      })
    }
  }
  return out
}
function parseIcsDate(v: string): string {
  // 20260814T093000Z | 20260814T093000 | 20260814
  const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?/)
  if (!m) return new Date().toISOString()
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : ''}`
  return iso
}

// ── Route ────────────────────────────────────────────────────────────────────
export function calendarRoutes() {
  const app = new Hono()

  app.get('/events', async c => {
    const days = Math.min(60, Math.max(1, Number(c.req.query('days') || 7)))
    if (cache && Date.now() - cache.at < CACHE_MS) return c.json({ events: cache.events, cached: true })
    const now = new Date()
    const timeMin = now.toISOString()
    const timeMax = new Date(now.getTime() + days * 86_400_000).toISOString()
    const accounts = loadAccounts()
    const results = await Promise.allSettled(accounts.map(a =>
      a.type === 'google-oauth' ? googleEvents(a, timeMin, timeMax)
      : /icloud|me\.com|mac\.com/.test(a.host) || /icloud|me\.com|mac\.com/.test(a.email) ? icloudEvents(a, timeMin, timeMax)
      : Promise.resolve([] as CalEvent[]),
    ))
    const events = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
      .sort((a, b) => a.start.localeCompare(b.start))
    cache = { at: Date.now(), events }
    const errors = results.map((r, i) => r.status === 'rejected'
      ? { email: accounts[i]?.email, error: String((r as PromiseRejectedResult).reason) } : null).filter(Boolean)
    return c.json({ events, errors })
  })

  return app
}
