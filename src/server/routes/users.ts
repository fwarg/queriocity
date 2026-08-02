import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { setCookie } from 'hono/cookie'
import { db, users, authCredentials, parseSettings, bumpTokenVersion } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import {
  hashPassword, verifyPassword, validatePassword, signToken, AUTH_COOKIE, COOKIE_OPTIONS,
} from '../lib/auth.ts'

export const usersRouter = new Hono<AppEnv>()

usersRouter.use('*', authMiddleware)

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'))

const settingsSchema = z.object({
  customPrompt: z.string().max(2000).optional(),
  showThinking: z.object({ balanced: z.boolean(), thorough: z.boolean() }).optional(),
  useThinking: z.boolean().optional(),
  useSpaceRag: z.boolean().optional(),
  useChatRag: z.boolean().optional(),
  fontSize: z.number().min(12).max(22).optional(),
  timezone: z.string().refine(v => !v || VALID_TIMEZONES.has(v), 'Invalid timezone').optional(),
  querySuggestions: z.boolean().optional(),
  followUpSuggestions: z.boolean().optional(),
})

usersRouter.post('/password', zValidator('json', z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
})), async (c) => {
  const userId = c.get('userId')
  const { currentPassword, newPassword } = c.req.valid('json')

  const pwError = validatePassword(newPassword)
  if (pwError) return c.json({ error: pwError }, 400)

  const cred = await db.select().from(authCredentials).where(eq(authCredentials.userId, userId)).get()
  if (!cred) return c.json({ error: 'No credentials for this account' }, 400)
  if (!await verifyPassword(currentPassword, cred.passwordHash)) {
    return c.json({ error: 'Current password is incorrect' }, 401)
  }

  await db.update(authCredentials)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
    .where(eq(authCredentials.userId, userId))

  // Invalidate every session, then re-issue a cookie for this one — so a stolen token dies
  // with the old password while the user changing it stays logged in.
  await bumpTokenVersion(userId)
  const user = await db.select().from(users).where(eq(users.id, userId)).get()
  if (user) {
    const token = await signToken({
      userId, email: user.email, role: user.role as 'user' | 'admin', tokenVersion: user.tokenVersion,
    })
    setCookie(c, AUTH_COOKIE, token, COOKIE_OPTIONS)
  }
  console.log(`  [auth] password changed for user ${userId}`)
  return c.json({ ok: true })
})

usersRouter.get('/settings', async (c) => {
  const user = await db.select({ settings: users.settings }).from(users)
    .where(eq(users.id, c.get('userId'))).get()
  if (!user) return c.json({ error: 'User not found' }, 404)
  return c.json(parseSettings(user.settings))
})

usersRouter.patch('/settings', zValidator('json', settingsSchema), async (c) => {
  const updates = c.req.valid('json')
  const user = await db.select({ settings: users.settings }).from(users)
    .where(eq(users.id, c.get('userId'))).get()
  if (!user) return c.json({ error: 'User not found' }, 404)
  const merged = { ...parseSettings(user.settings), ...updates }
  await db.update(users)
    .set({ settings: JSON.stringify(merged), updatedAt: new Date() })
    .where(eq(users.id, c.get('userId')))
  return c.json(merged)
})
