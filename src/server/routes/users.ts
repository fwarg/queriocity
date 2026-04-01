import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db, users, parseSettings } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'

export const usersRouter = new Hono<AppEnv>()

usersRouter.use('*', authMiddleware)

const settingsSchema = z.object({
  customPrompt: z.string().max(2000).optional(),
  showThinking: z.object({ balanced: z.boolean(), thorough: z.boolean() }).optional(),
  useThinking: z.boolean().optional(),
  fontSize: z.number().min(12).max(22).optional(),
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
