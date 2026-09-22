// ---------------------------------------------------------------------------
// Partner AI Gateway — unified AI routing service
//
// Endpoints:
//   POST /chat             — text generation (Claude / OpenAI / Gemini / Perplexity)
//   POST /audio/tts        — text → speech (ElevenLabs / OpenAI)
//   POST /audio/stt        — speech → text (Whisper via OpenAI)
//   GET  /keys             — which providers are configured
//   PUT  /keys/:provider   — set key at runtime
//   GET  /health           — liveness check
// ---------------------------------------------------------------------------

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { loadKeys }         from './keys.ts'
import { authMiddleware }   from './middleware/auth.ts'
import { loggerMiddleware } from './middleware/logger.ts'
import { chatRoutes }       from './routes/chat.ts'
import { audioRoutes }      from './routes/audio.ts'
import { keysRoutes }       from './routes/keys.ts'
import { mailRoutes }       from './routes/mail.ts'
import { calendarRoutes }   from './routes/calendar.ts'
import { agentRoutes }         from './routes/agents.ts'
import { communicationRoutes } from './routes/communication.ts'
import { captureRoutes }       from './routes/capture.ts'
import { priorityRoutes }      from './routes/priority.ts'
import { askRoutes }           from './routes/ask.ts'
import { brainRoutes }         from './routes/brain.ts'
import { ollamaStatus, DEFAULT_OLLAMA_URL, DEFAULT_OLLAMA_MODEL } from './providers/ollama.ts'
import { drainAlerts } from './alerts.ts'

const PORT = Number(process.env['GATEWAY_PORT'] ?? 4000)

// Path to built frontend — served when WEB=1 (mobile/web mode)
const DIST = resolve(import.meta.dirname ?? process.cwd(), '../../../apps/desktop/dist')

const keys = loadKeys()

const app = new Hono()

// Middleware
app.use('*', loggerMiddleware)
app.use('*', cors({ origin: '*' }))   // tighten in production
app.use('/keys/*', authMiddleware)     // key management always requires auth

// Health — u Ollamy se navíc ověří, jestli lokální server běží a jaké má modely
app.get('/health', async (c) => {
  const ollama = await ollamaStatus(keys.ollamaUrl ?? DEFAULT_OLLAMA_URL)
  return c.json({
    status: 'ok',
    providers: {
      claude:     !!keys.claude,
      openai:     !!keys.openai,
      gemini:     !!keys.gemini,
      perplexity: !!keys.perplexity,
      elevenlabs: !!keys.elevenlabs,
      ollama:     ollama.up,
    },
    ollama: {
      up:      ollama.up,
      url:     keys.ollamaUrl ?? DEFAULT_OLLAMA_URL,
      models:  ollama.models,
      default: keys.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
    },
  })
})

// Provider alerts — frontend polls this every 30s to show billing/error notifications
app.get('/alerts', (c) => c.json({ alerts: drainAlerts() }))

// Routes
app.route('/chat',  chatRoutes(keys))
app.route('/audio', audioRoutes(keys))
app.route('/keys',  keysRoutes(keys))
app.route('/mail',  mailRoutes())
app.route('/calendar', calendarRoutes())
app.route('/agents', agentRoutes(keys))
app.route('/communication', communicationRoutes(keys))
app.route('/capture',       captureRoutes(keys))
app.route('/priority',      priorityRoutes(keys))
app.route('/ask',           askRoutes(keys))
app.route('/brain',         brainRoutes(keys))
// Partner Voice compat: /v1/captures → same handler
app.route('/v1/captures',   captureRoutes(keys))

// ---------------------------------------------------------------------------
// Static frontend (WEB=1 or --web flag) — serves built React app on same port
// ---------------------------------------------------------------------------

const webMode = process.env['WEB'] === '1' || process.argv.includes('--web')

if (webMode) {
  if (!existsSync(DIST)) {
    console.warn(`[web] Frontend není zbuildovaný (${DIST}). Spusť nejdřív: pnpm web:build`)
  } else {
    // Serve static assets (JS/CSS/icons)
    app.use('/assets/*', serveStatic({ root: DIST }))
    app.use('/icon*', serveStatic({ root: DIST }))
    app.use('/manifest*', serveStatic({ root: DIST }))
    app.use('/sw.js', serveStatic({ root: DIST }))
    app.use('/apple-touch-icon*', serveStatic({ root: DIST }))

    // SPA fallback — every unknown route returns index.html
    const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf-8')
    app.get('*', (c) => {
      return c.html(indexHtml)
    })

    console.log(`[web] Frontend servírován z ${DIST}`)
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

console.log(`
┌──────────────────────────────────────────┐
│       Partner AI Gateway v0.1.0          │
│                                          │
│  POST /chat          — text generation   │
│  POST /audio/tts     — text → speech     │
│  POST /audio/stt     — speech → text     │
│  GET  /health        — status            │
│  GET  /keys          — configured keys   │
└──────────────────────────────────────────┘
`)

const configured = Object.entries({
  Claude:      keys.claude,
  OpenAI:      keys.openai,
  Gemini:      keys.gemini,
  Perplexity:  keys.perplexity,
  ElevenLabs:  keys.elevenlabs,
}).filter(([, v]) => v).map(([k]) => k)

console.log(`Providers: ${configured.length > 0 ? configured.join(', ') : 'none configured — set via ENV or PUT /keys/:provider'}`)
console.log(`Listening on http://localhost:${PORT}\n`)

serve({ fetch: app.fetch, port: PORT, hostname: process.env['GATEWAY_HOST'] ?? '0.0.0.0' })
