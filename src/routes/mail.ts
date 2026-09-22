// ---------------------------------------------------------------------------
// Mail bridge — IMAP přes app-specific hesla NEBO Google OAuth (XOAUTH2).
// Údaje zůstávají LOKÁLNĚ (~/.config/partner-voice/, 0600), nikdy do cloudu.
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import { ImapFlow } from 'imapflow'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

export type AuthType = 'password' | 'google-oauth'
export interface MailAccount {
  email:    string
  type:     AuthType
  password?:     string   // app-specific heslo
  refreshToken?: string   // google-oauth
  host:     string
  port:     number
  label?:   string
}
export interface StoredMsg {
  account: string; uid: number; from: string; fromName: string
  subject: string; date: string; preview: string
}

const DIR = join(homedir(), '.config', 'partner-voice')
const ACCOUNTS = join(DIR, 'mail-accounts.json')
const OAUTH = join(DIR, 'google-oauth.json')
const REDIRECT = 'http://127.0.0.1:4000/mail/oauth/callback'
const SCOPES = 'openid email https://mail.google.com/ https://www.googleapis.com/auth/calendar.readonly'

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* */ }
}
export const loadAccounts = () => readJson<MailAccount[]>(ACCOUNTS, [])
const saveAccounts = (l: MailAccount[]) => writeJson(ACCOUNTS, l)
const loadOAuthCfg = () => readJson<{ clientId?: string; clientSecret?: string }>(OAUTH, {})

function detectHost(email: string): { host: string; port: number } | null {
  const d = (email.split('@')[1] || '').toLowerCase()
  if (d === 'gmail.com' || d === 'googlemail.com') return { host: 'imap.gmail.com', port: 993 }
  if (d === 'icloud.com' || d === 'me.com' || d === 'mac.com') return { host: 'imap.mail.me.com', port: 993 }
  if (d === 'outlook.com' || d === 'hotmail.com' || d === 'live.com') return { host: 'outlook.office365.com', port: 993 }
  if (d === 'yahoo.com') return { host: 'imap.mail.yahoo.com', port: 993 }
  if (d === 'seznam.cz') return { host: 'imap.seznam.cz', port: 993 }
  return null
}

// ── Google OAuth token helpers ───────────────────────────────────────────────
async function exchangeCode(code: string, verifier: string): Promise<{ access: string; refresh: string }> {
  const cfg = loadOAuthCfg()
  const body = new URLSearchParams({
    code, client_id: cfg.clientId!, client_secret: cfg.clientSecret!,
    redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: verifier,
  })
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })
  const j = await r.json() as { access_token?: string; refresh_token?: string; error?: string; error_description?: string }
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || 'token exchange failed')
  return { access: j.access_token, refresh: j.refresh_token || '' }
}
export async function refreshAccess(refreshToken: string): Promise<string> {
  const cfg = loadOAuthCfg()
  const body = new URLSearchParams({
    refresh_token: refreshToken, client_id: cfg.clientId!, client_secret: cfg.clientSecret!,
    grant_type: 'refresh_token',
  })
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })
  const j = await r.json() as { access_token?: string; error_description?: string }
  if (!r.ok || !j.access_token) throw new Error(j.error_description || 'refresh failed')
  return j.access_token
}
async function userEmail(accessToken: string): Promise<string> {
  const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
  const j = await r.json() as { email?: string }
  return j.email || ''
}

// ── IMAP klient (heslo NEBO oauth accessToken) ───────────────────────────────
async function newClient(acc: MailAccount): Promise<ImapFlow> {
  const auth = acc.type === 'google-oauth'
    ? { user: acc.email, accessToken: await refreshAccess(acc.refreshToken!) }
    : { user: acc.email, pass: acc.password! }
  return new ImapFlow({
    host: acc.host, port: acc.port, secure: true, auth, logger: false, emitLogs: false,
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000,
  })
}

let cache: { at: number; msgs: StoredMsg[] } | null = null
const CACHE_MS = 60_000

// Najdi v bodyStructure první textovou část (plain preferovaně, html jako záloha).
function findTextPart(node: any): { part: string; html: boolean } | null {
  if (!node) return null
  if (node.childNodes?.length) {
    for (const c of node.childNodes) { const r = findTextPart(c); if (r) return r }
  }
  if (node.type === 'text/plain') return { part: node.part || '1', html: false }
  if (node.type === 'text/html') return { part: node.part || '1', html: true }
  return null
}
async function readSnippet(stream: NodeJS.ReadableStream, html: boolean): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const ch of stream) {
    chunks.push(ch as Buffer); total += (ch as Buffer).length
    if (total > 4000) break   // stačí úvod mailu
  }
  let text = Buffer.concat(chunks).toString('utf8')
  if (html) text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  return text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 400)
}

async function fetchUnreadFor(acc: MailAccount, limit: number): Promise<StoredMsg[]> {
  const client = await newClient(acc)
  // Zachyť unhandled error eventy — bez toho zabíjí celý Node.js process
  client.on('error', (err: Error) => { console.error(`[imap] ${acc.email} error:`, err.message) })
  const out: StoredMsg[] = []
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  try {
    const uids = await client.search({ seen: false }, { uid: true })
    const take = (uids || []).slice(-limit)
    if (take.length) {
      for await (const m of client.fetch(take, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
        const from = m.envelope?.from?.[0]
        let preview = ''
        try {
          const tp = findTextPart(m.bodyStructure)
          if (tp) {
            const dl = await client.download(String(m.uid), tp.part, { uid: true })
            if (dl?.content) preview = await readSnippet(dl.content, tp.html)
          }
        } catch { /* preview je bonus, ne nutnost */ }
        out.push({
          account: acc.email, uid: m.uid,
          from: from?.address ?? '', fromName: from?.name ?? from?.address ?? '',
          subject: m.envelope?.subject ?? '(bez předmětu)',
          date: (m.envelope?.date ?? new Date()).toISOString(), preview,
        })
      }
    }
  } finally { lock.release(); await client.logout().catch(() => {}) }
  return out
}

// Sdílené: nepřečtené napříč účty (s cache) — používá /unread i inbox agent.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(res => setTimeout(() => res(fallback), ms))])
}
export async function collectUnread(limit = 25): Promise<StoredMsg[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.msgs.slice(0, limit)
  const accounts = loadAccounts()
  const per = Math.max(5, Math.ceil(limit / Math.max(1, accounts.length)) + 3)
  const results = await Promise.allSettled(accounts.map(a => withTimeout(fetchUnreadFor(a, per), 40_000, [] as StoredMsg[])))
  const msgs = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit)
  cache = { at: Date.now(), msgs }
  return msgs
}

// Načte posledních N zpráv z INBOX bez ohledu na přečtení (pro CEO Inbox).
// Rychlá verze: jen envelope (bez stahování těla) aby se nepřekročil socket timeout.
async function fetchRecentFor(acc: MailAccount, limit: number): Promise<StoredMsg[]> {
  const client = await newClient(acc)
  client.on('error', (err: Error) => { console.error(`[imap] ${acc.email}:`, err.message) })
  const out: StoredMsg[] = []
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  try {
    // Hledej zprávy z posledních 7 dní — vrátí UIDs
    const since = new Date()
    since.setDate(since.getDate() - 7)
    const uids = await client.search({ since }, { uid: true })
    if (!uids?.length) return out
    // Vezmi jen posledních `limit` (nejvyšší UID = nejnovější)
    const take = uids.slice(-limit)
    // Fetch jen envelope (předmět, odesílatel, datum) — bez těla, rychlé
    for await (const m of client.fetch(take, { uid: true, envelope: true }, { uid: true })) {
      const from0 = m.envelope?.from?.[0]
      out.push({
        account: acc.email, uid: m.uid,
        from: from0?.address ?? '', fromName: from0?.name ?? from0?.address ?? '',
        subject: m.envelope?.subject ?? '(bez předmětu)',
        date: (m.envelope?.date ?? new Date()).toISOString(),
        preview: '',  // preview načteme jen u mailů kde to AI vyžaduje
      })
    }
  } finally { lock.release(); await client.logout().catch(() => {}) }
  return out
}

let recentCache: { at: number; msgs: StoredMsg[] } | null = null
const RECENT_CACHE_MS = 2 * 60 * 1000

export async function collectRecent(limit = 30): Promise<StoredMsg[]> {
  if (recentCache && Date.now() - recentCache.at < RECENT_CACHE_MS) return recentCache.msgs.slice(0, limit)
  const accounts = loadAccounts()
  const per = Math.max(8, Math.ceil(limit / Math.max(1, accounts.length)) + 5)
  const results = await Promise.allSettled(accounts.map(a => withTimeout(fetchRecentFor(a, per), 45_000, [] as StoredMsg[])))
  const msgs = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit)
  recentCache = { at: Date.now(), msgs }
  return msgs
}

// PKCE + state (in-memory, krátkodobé)
const pending = new Map<string, string>()   // state → verifier

export function mailRoutes() {
  const app = new Hono()

  app.get('/accounts', c => c.json({
    accounts: loadAccounts().map(a => ({ email: a.email, host: a.host, label: a.label, type: a.type })),
  }))

  // Přidat účet app-heslem
  app.post('/accounts', async c => {
    const body = await c.req.json() as { email?: string; password?: string; host?: string; port?: number }
    const email = (body.email || '').trim(); const password = (body.password || '').trim()
    if (!email || !password) return c.json({ error: 'email a heslo jsou povinné' }, 400)
    const det = detectHost(email)
    const host = (body.host || det?.host || '').trim(); const port = body.port || det?.port || 993
    if (!host) return c.json({ error: 'Neznámý poskytovatel — zadej IMAP server (host)' }, 400)
    const acc: MailAccount = { email, type: 'password', password, host, port }
    try { const cl = await newClient(acc); await cl.connect(); await cl.logout().catch(() => {}) }
    catch (e) { return c.json({ error: `Přihlášení selhalo: ${e instanceof Error ? e.message : String(e)}. Používáš app-specific heslo?` }, 401) }
    const list = loadAccounts().filter(a => a.email !== email); list.push(acc); saveAccounts(list); cache = null
    return c.json({ ok: true, email, host })
  })

  app.delete('/accounts/:email', c => {
    saveAccounts(loadAccounts().filter(a => a.email !== c.req.param('email'))); cache = null
    return c.json({ ok: true })
  })

  // ── Google OAuth ──────────────────────────────────────────────────────────
  app.get('/oauth/config', c => { const cfg = loadOAuthCfg(); return c.json({ configured: !!(cfg.clientId && cfg.clientSecret) }) })
  app.post('/oauth/config', async c => {
    const { clientId, clientSecret } = await c.req.json() as { clientId?: string; clientSecret?: string }
    if (!clientId || !clientSecret) return c.json({ error: 'clientId a clientSecret povinné' }, 400)
    writeJson(OAUTH, { clientId: clientId.trim(), clientSecret: clientSecret.trim() })
    return c.json({ ok: true })
  })

  // Vrátí URL pro přihlášení (frontend ji otevře v prohlížeči)
  app.get('/oauth/start', c => {
    const cfg = loadOAuthCfg()
    if (!cfg.clientId) return c.json({ error: 'Nejdřív nastav Google Client ID/Secret' }, 400)
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('hex')
    pending.set(state, verifier)
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: REDIRECT, response_type: 'code',
      scope: SCOPES, access_type: 'offline', prompt: 'consent',
      code_challenge: challenge, code_challenge_method: 'S256', state,
    }).toString()
    return c.json({ url })
  })

  // Callback z Googlu — vymění kód, uloží účet, zobrazí potvrzení
  app.get('/oauth/callback', async c => {
    const code = c.req.query('code'); const state = c.req.query('state')
    const verifier = state ? pending.get(state) : undefined
    const html = (msg: string, ok: boolean) =>
      c.html(`<html><body style="font-family:-apple-system,sans-serif;background:${ok ? '#f2effc' : '#fdecec'};display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;padding:2rem"><div style="font-size:2.5rem">${ok ? '✅' : '⚠️'}</div><p style="font-size:1.1rem;color:#333;max-width:340px">${msg}</p><p style="color:#888;font-size:.85rem">Okno můžeš zavřít a vrátit se do Partnera.</p></div></body></html>`)
    if (!code || !verifier) return html('Přihlášení se nezdařilo (chybí kód). Zkus to znovu.', false)
    pending.delete(state!)
    try {
      const tok = await exchangeCode(code, verifier)
      if (!tok.refresh) throw new Error('Google nevrátil refresh token — odvolej přístup v účtu a zkus znovu (prompt=consent).')
      const email = await userEmail(tok.access)
      if (!email) throw new Error('Nepodařilo se zjistit e-mail účtu.')
      const acc: MailAccount = { email, type: 'google-oauth', refreshToken: tok.refresh, host: 'imap.gmail.com', port: 993 }
      const list = loadAccounts().filter(a => a.email !== email); list.push(acc); saveAccounts(list); cache = null
      return html(`Účet <b>${email}</b> je připojený. Maily se objeví ve Flow.`, true)
    } catch (e) {
      return html(`Připojení selhalo: ${e instanceof Error ? e.message : String(e)}`, false)
    }
  })

  // Nepřečtené napříč účty (sdílí cache + per-účet timeout s collectUnread)
  app.get('/unread', async c => {
    const limit = Number(c.req.query('limit') || 20)
    const msgs = await collectUnread(limit)
    return c.json({ messages: msgs })
  })

  app.post('/read', async c => {
    const { account, uid } = await c.req.json() as { account?: string; uid?: number }
    const acc = loadAccounts().find(a => a.email === account)
    if (!acc || !uid) return c.json({ error: 'account + uid povinné' }, 400)
    try {
      const client = await newClient(acc); await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try { await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true }) }
      finally { lock.release(); await client.logout().catch(() => {}) }
      cache = null; return c.json({ ok: true })
    } catch (e) { return c.json({ error: String(e) }, 500) }
  })

  return app
}
