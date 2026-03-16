import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyToken, AUTH_COOKIE } from '../lib/auth.ts'

export type AppEnv = { Variables: { userId: string; userRole: 'user' | 'admin' } }

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, AUTH_COOKIE)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const user = await verifyToken(token)
    c.set('userId', user.userId)
    c.set('userRole', user.role)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
}

export const adminMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await next()
}
