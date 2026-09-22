import type { MiddlewareHandler } from 'hono'

// Simple shared-secret auth for local / internal use.
// Set GATEWAY_SECRET env var; omit to run without auth (dev mode).

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const secret = process.env['GATEWAY_SECRET']
  if (!secret) {
    await next()
    return
  }

  const auth = c.req.header('Authorization') ?? c.req.header('x-gateway-key')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth

  if (token !== secret) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
}
