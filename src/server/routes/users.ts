import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { setCookie } from 'hono/cookie'
import { db, users, userMemories, authCredentials, parseSettings, bumpTokenVersion } from '../lib/db.ts'
import { eq, and } from 'drizzle-orm'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import {
  hashPassword, verifyPassword, validatePassword, signToken, AUTH_COOKIE, COOKIE_OPTIONS,
} from '../lib/auth.ts'
import { getUserMemories, saveUserMemory, deleteUserMemory, embedMemory, suggestUserMemories } from '../lib/memory.ts'

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
  /** Off by default: when disabled neither the block nor the save_user_fact tool is added, so
   *  prompt size and tool count are unchanged for anyone who has not opted in. */
  userMemory: z.boolean().optional(),
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

// --- User-level memory ---
// Scoped entirely by the authenticated user id; there is no cross-user read path, and admin
// routes deliberately do not expose these.

usersRouter.get('/memories', async (c) => {
  return c.json({ memories: await getUserMemories(c.get('userId')) })
})

usersRouter.post('/memories', zValidator('json', z.object({
  content: z.string().min(1).max(500),
})), async (c) => {
  const userId = c.get('userId')
  const id = await saveUserMemory(userId, c.req.valid('json').content, 'manual')
  const memory = await db.select().from(userMemories).where(eq(userMemories.id, id)).get()
  return c.json(memory, 201)
})

usersRouter.patch('/memories/:id', zValidator('json', z.object({
  content: z.string().min(1).max(500).optional(),
  alwaysKeep: z.boolean().optional(),
})), async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const memory = await db.select().from(userMemories)
    .where(and(eq(userMemories.id, id), eq(userMemories.userId, userId))).get()
  if (!memory) return c.json({ error: 'Not found' }, 404)

  const { content, alwaysKeep } = c.req.valid('json')
  if (content == null && alwaysKeep == null) return c.json({ error: 'Nothing to update' }, 400)
  await db.update(userMemories).set({
    ...(content != null ? { content } : {}),
    ...(alwaysKeep != null ? { alwaysKeep } : {}),
    updatedAt: new Date(),
  }).where(eq(userMemories.id, id))

  if (content != null && content !== memory.content) await embedMemory(id, content)
  return c.json({ ok: true })
})

usersRouter.delete('/memories/:id', async (c) => {
  const removed = await deleteUserMemory(c.get('userId'), c.req.param('id'))
  return removed ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
})

/** Proposes user-level facts from the caller's own recent chats. Returns candidates for review —
 *  nothing is saved until the user posts one back via POST /memories. Streams progress because
 *  the scan makes one model call per session. */
usersRouter.post('/memories/suggest', async (c) => {
  const userId = c.get('userId')
  // Clamped in suggestUserMemories, which owns the ceiling; a bad value falls back to the default.
  const sessionLimit = parseInt(c.req.query('limit') ?? '') || undefined
  const encoder = new TextEncoder()
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(x) { ctrl = x } })
  const send = (obj: object) => ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))

  ;(async () => {
    // 2KB padding comment to flush the browser's initial SSE buffer, as in recreate-memories.
    ctrl.enqueue(encoder.encode(': ' + ' '.repeat(2048) + '\n\n'))
    try {
      const suggestions = await suggestUserMemories(userId, sessionLimit, (done, total) => send({ processing: done, total }))
      send({ done: true, suggestions })
    } catch (e) {
      console.error('[user-memory suggest]', e)
      send({ done: true, suggestions: [], error: 'Suggestion scan failed' })
    }
    ctrl.close()
  })().catch(e => { console.error('[user-memory suggest] stream error:', e); ctrl.close() })

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
})
