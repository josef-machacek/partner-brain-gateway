import { Hono } from 'hono'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KeyStore } from '../types.ts'

const __dir = dirname(fileURLToPath(import.meta.url))

export function keysRoutes(keys: KeyStore) {
  const app = new Hono()

  // GET /keys — which providers are configured (no values exposed)
  app.get('/', (c) => {
    return c.json({
      claude:     !!keys.claude,
      openai:     !!keys.openai,
      gemini:     !!keys.gemini,
      perplexity: !!keys.perplexity,
      elevenlabs: !!keys.elevenlabs,
    })
  })

  // PUT /keys/:provider — set a key at runtime (persisted to .keys.json)
  app.put('/:provider', async (c) => {
    const provider = c.req.param('provider') as keyof KeyStore
    const { key } = await c.req.json<{ key: string }>()

    if (!key) return c.json({ error: 'key is required' }, 400)

    const allowed: (keyof KeyStore)[] = ['claude', 'openai', 'gemini', 'perplexity', 'elevenlabs']
    if (!allowed.includes(provider)) {
      return c.json({ error: `Unknown provider: ${provider}` }, 400)
    }

    keys[provider] = key

    // Persist to .keys.json (gitignored)
    try {
      const path = resolve(__dir, '../../.keys.json')
      const current = (() => {
        try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
      })()
      writeFileSync(path, JSON.stringify({ ...current, [provider]: key }, null, 2))
    } catch { /* env-only mode — no file persistence */ }

    return c.json({ ok: true, provider })
  })

  // DELETE /keys/:provider — remove a key
  app.delete('/:provider', (c) => {
    const provider = c.req.param('provider') as keyof KeyStore
    delete keys[provider]
    return c.json({ ok: true, provider })
  })

  return app
}
