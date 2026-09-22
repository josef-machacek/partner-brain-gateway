import type { MiddlewareHandler } from 'hono'

export const loggerMiddleware: MiddlewareHandler = async (c, next) => {
  const start  = Date.now()
  const method = c.req.method
  const path   = new URL(c.req.url).pathname

  await next()

  const ms     = Date.now() - start
  const status = c.res.status
  const emoji  = status < 300 ? '✅' : status < 500 ? '⚠️' : '❌'
  console.log(`${emoji}  ${method} ${path} → ${status} (${ms}ms)`)
}
