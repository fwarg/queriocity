import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { db, users } from '../lib/db.ts'
import { verifyToken, AUTH_COOKIE } from '../lib/auth.ts'

export type AppEnv = { Variables: { userId: string; userRole: 'user' | 'admin' } }

/** The user behind the request's cookie, or null when it is missing, invalid or revoked. */
export async function currentUser(c: Context): Promise<{ userId: string; role: 'user' | 'admin' } | null> {
  const token = getCookie(c, AUTH_COOKIE)
  if (!token) return null
  const claims = await verifyToken(token).catch(() => null)
  if (!claims) return null

  // Role and revocation state come from the database, never from the token: a deleted or
  // demoted user must lose access on their next request, not when the token expires.
  const user = await db.select({ role: users.role, tokenVersion: users.tokenVersion })
    .from(users).where(eq(users.id, claims.userId)).get()
  if (!user || user.tokenVersion !== claims.tokenVersion) return null
  return { userId: claims.userId, role: user.role }
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  c.set('userId', user.userId)
  c.set('userRole', user.role)
  await next()
}

export const adminMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await next()
}
