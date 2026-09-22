import { Hono } from 'hono'
import { route } from '../router.ts'
import type { KeyStore, GatewayRequest } from '../types.ts'

export function chatRoutes(keys: KeyStore) {
  const app = new Hono()

  // POST /chat — main endpoint
  app.post('/', async (c) => {
    let body: GatewayRequest
    try {
      body = await c.req.json<GatewayRequest>()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.messages?.length) {
      return c.json({ error: 'messages array is required' }, 400)
    }

    try {
      const result = await route(body, keys)
      return c.json(result)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[gateway/chat]', msg)
      return c.json({ error: msg }, 502)
    }
  })

  return app
}
