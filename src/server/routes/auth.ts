import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { db, users, authCredentials, invites } from '../lib/db.ts'
import { eq, count } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import {
  hashPassword, verifyPassword, signToken, verifyToken,
  validatePassword, AUTH_COOKIE, COOKIE_OPTIONS,
} from '../lib/auth.ts'

export const authRouter = new Hono()

authRouter.get('/has-users', async (c) => {
  const [{ value }] = await db.select({ value: count() }).from(users)
  return c.json({ hasUsers: value > 0 })
})

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  name: z.string().optional(),
  inviteToken: z.string().optional(),
})

authRouter.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, password, name, inviteToken } = c.req.valid('json')

  const pwError = validatePassword(password)
  if (pwError) return c.json({ error: pwError }, 400)

  const [{ value: userCount }] = await db.select({ value: count() }).from(users)

  if (userCount > 0) {
    if (!inviteToken) return c.json({ error: 'Invite required' }, 403)
    const invite = await db.select().from(invites).where(eq(invites.id, inviteToken)).get()
    if (!invite) return c.json({ error: 'Invalid invite' }, 403)
    if (invite.usedAt) return c.json({ error: 'Invite already used' }, 403)
    if (invite.expiresAt < new Date()) return c.json({ error: 'Invite expired' }, 403)
    if (invite.email && invite.email.toLowerCase() !== email.toLowerCase())
      return c.json({ error: 'Invite is for a different email address' }, 403)
    await db.update(invites).set({ usedAt: new Date() }).where(eq(invites.id, inviteToken))
  }

  const existing = await db.select().from(authCredentials)
    .where(eq(authCredentials.email, email.toLowerCase())).get()
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const role: 'user' | 'admin' = userCount === 0 ? 'admin' : 'user'
  const userId = randomUUID()
  const now = new Date()
  const passwordHash = await hashPassword(password)

  await db.insert(users).values({
    id: userId, email: email.toLowerCase(), name: name ?? null,
    role, settings: '{}', createdAt: now, updatedAt: now,
  })
  await db.insert(authCredentials).values({
    userId, email: email.toLowerCase(), passwordHash, active: true,
  })

  const token = await signToken({ userId, email: email.toLowerCase(), role })
  setCookie(c, AUTH_COOKIE, token, COOKIE_OPTIONS)
  return c.json({ id: userId, email: email.toLowerCase(), name: name ?? null, role }, 201)
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

authRouter.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json')
  const cred = await db.select().from(authCredentials)
    .where(eq(authCredentials.email, email.toLowerCase())).get()
  if (!cred || !cred.active) return c.json({ error: 'Invalid credentials' }, 401)
  const ok = await verifyPassword(password, cred.passwordHash)
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401)
  const user = await db.select().from(users).where(eq(users.id, cred.userId)).get()
  if (!user) return c.json({ error: 'User not found' }, 500)
  const token = await signToken({ userId: user.id, email: user.email, role: user.role as 'user' | 'admin' })
  setCookie(c, AUTH_COOKIE, token, COOKIE_OPTIONS)
  return c.json({ id: user.id, email: user.email, name: user.name, role: user.role })
})

authRouter.post('/logout', (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

authRouter.get('/me', async (c) => {
  const token = getCookie(c, AUTH_COOKIE)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const { userId } = await verifyToken(token)
    const user = await db.select().from(users).where(eq(users.id, userId)).get()
    if (!user) return c.json({ error: 'User not found' }, 404)
    return c.json({
      id: user.id, email: user.email, name: user.name,
      role: user.role, settings: JSON.parse(user.settings),
    })
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})
