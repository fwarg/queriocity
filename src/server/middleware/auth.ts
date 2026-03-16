import type { MiddlewareHandler } from 'hono'
import { verifyToken } from '../lib/auth.ts'

export type AppEnv = { Variables: { userId: string } }

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  try {
    const userId = await verifyToken(header.slice(7))
    c.set('userId', userId)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
}
