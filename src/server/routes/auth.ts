import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { db, users, authCredentials, invites, parseSettings, getAppSetting } from '../lib/db.ts'
import { eq, count } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import {
  hashPassword, verifyPassword, signToken, verifyToken,
  validatePassword, AUTH_COOKIE, COOKIE_OPTIONS,
} from '../lib/auth.ts'
import { RateLimiter, clientIp, warnIfProxyUntrusted } from '../lib/rate-limit.ts'
import { LANG_CODES } from '../../shared/i18n/index.ts'

export const authRouter = new Hono()

// Max 10 attempts per 15 minutes per client address, for both login and registration.
const authAttempts = new RateLimiter(10, 15 * 60 * 1000)

// Compared against when the email is unknown, so a miss costs the same time as a wrong
// password and the response can't be used to enumerate registered addresses.
const DUMMY_HASH = bcrypt.hashSync('unused-placeholder-for-constant-time-compare', 12)

authRouter.get('/has-users', async (c) => {
  const [{ value }] = await db.select({ value: count() }).from(users)
  return c.json({ hasUsers: value > 0 })
})

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  name: z.string().optional(),
  inviteToken: z.string().optional(),
  /** Chosen in the sign-up form. Stored with the row rather than PATCHed afterwards, so the
   *  choice survives a follow-up request that never lands. */
  language: z.enum(LANG_CODES).optional(),
})

authRouter.post('/register', zValidator('json', registerSchema), async (c) => {
  warnIfProxyUntrusted(c)
  if (!authAttempts.check(clientIp(c))) return c.json({ error: 'Too many attempts. Try again later.', code: 'too_many_attempts' }, 429)

  const { email, password, name, inviteToken, language } = c.req.valid('json')

  const pwError = validatePassword(password)
  if (pwError) return c.json({ error: pwError }, 400)

  const [{ value: userCount }] = await db.select({ value: count() }).from(users)

  if (userCount > 0) {
    if (!inviteToken) return c.json({ error: 'Invite required', code: 'invite_required' }, 403)
    const invite = await db.select().from(invites).where(eq(invites.id, inviteToken)).get()
    if (!invite) return c.json({ error: 'Invalid invite', code: 'invite_invalid' }, 403)
    if (invite.usedAt) return c.json({ error: 'Invite already used', code: 'invite_used' }, 403)
    if (invite.expiresAt < new Date()) return c.json({ error: 'Invite expired', code: 'invite_expired' }, 403)
    if (invite.email && invite.email.toLowerCase() !== email.toLowerCase())
      return c.json({ error: 'Invite is for a different email address', code: 'invite_email_mismatch' }, 403)
  }

  const existing = await db.select().from(authCredentials)
    .where(eq(authCredentials.email, email.toLowerCase())).get()
  if (existing) return c.json({ error: 'Email already registered', code: 'email_registered' }, 409)

  // Consumed only once registration is certain to proceed. Marking it above, before the
  // duplicate-email check, meant someone who already had an account burned their own invite by
  // opening the link a second time — and only an admin could issue another.
  if (userCount > 0 && inviteToken) {
    await db.update(invites).set({ usedAt: new Date() }).where(eq(invites.id, inviteToken))
  }

  const role: 'user' | 'admin' = userCount === 0 ? 'admin' : 'user'
  const userId = randomUUID()
  const now = new Date()
  const passwordHash = await hashPassword(password)

  await db.insert(users).values({
    id: userId, email: email.toLowerCase(), name: name ?? null,
    role, settings: JSON.stringify(language ? { language } : {}), createdAt: now, updatedAt: now,
  })
  await db.insert(authCredentials).values({
    userId, email: email.toLowerCase(), passwordHash, active: true,
  })

  const token = await signToken({ userId, email: email.toLowerCase(), role, tokenVersion: 0 })
  setCookie(c, AUTH_COOKIE, token, COOKIE_OPTIONS)
  return c.json({
    id: userId, email: email.toLowerCase(), name: name ?? null, role,
    settings: language ? { language } : {},
  }, 201)
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

authRouter.post('/login', zValidator('json', loginSchema), async (c) => {
  warnIfProxyUntrusted(c)
  if (!authAttempts.check(clientIp(c))) return c.json({ error: 'Too many login attempts. Try again later.', code: 'too_many_attempts' }, 429)

  const { email, password } = c.req.valid('json')
  const cred = await db.select().from(authCredentials)
    .where(eq(authCredentials.email, email.toLowerCase())).get()
  const ok = await verifyPassword(password, cred?.passwordHash ?? DUMMY_HASH)
  if (!cred || !cred.active || !ok) return c.json({ error: 'Invalid credentials', code: 'invalid_credentials' }, 401)
  const user = await db.select().from(users).where(eq(users.id, cred.userId)).get()
  if (!user) return c.json({ error: 'User not found' }, 500)
  const token = await signToken({ userId: user.id, email: user.email, role: user.role as 'user' | 'admin', tokenVersion: user.tokenVersion })
  setCookie(c, AUTH_COOKIE, token, COOKIE_OPTIONS)
  return c.json({ id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: cred.mustChangePassword })
})

authRouter.post('/logout', (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

authRouter.get('/me', async (c) => {
  const token = getCookie(c, AUTH_COOKIE)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const { userId, tokenVersion } = await verifyToken(token)
    const [user, memoryTokenBudget, cred] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)).get(),
      getAppSetting('memory_token_budget', '1000').then(v => parseInt(v)),
      db.select({ mustChangePassword: authCredentials.mustChangePassword })
        .from(authCredentials).where(eq(authCredentials.userId, userId)).get(),
    ])
    if (!user) return c.json({ error: 'User not found' }, 404)
    if (user.tokenVersion !== tokenVersion) return c.json({ error: 'Invalid token' }, 401)
    return c.json({
      id: user.id, email: user.email, name: user.name,
      role: user.role, settings: parseSettings(user.settings),
      memoryTokenBudget,
      mustChangePassword: cred?.mustChangePassword ?? false,
    })
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})
