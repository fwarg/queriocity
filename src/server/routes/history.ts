import { Hono } from 'hono'
import { db, chatSessions, messages } from '../lib/db.ts'
import { eq, and, desc } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'

export const historyRouter = new Hono<AppEnv>()

historyRouter.use('*', authMiddleware)

historyRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200)
  const offset = parseInt(c.req.query('offset') ?? '0')
  const sessions = await db.select().from(chatSessions)
    .where(eq(chatSessions.userId, userId))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(limit)
    .offset(offset)
  return c.json(sessions)
})

historyRouter.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const session = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId))).get()

  if (!session) return c.json({ error: 'Not found' }, 404)

  const msgs = await db.select().from(messages).where(eq(messages.sessionId, id))

  return c.json({ session, messages: msgs })
})

historyRouter.patch('/:id', zValidator('json', z.object({ title: z.string().min(1).max(200) })), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const { title } = c.req.valid('json')

  const session = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId))).get()

  if (!session) return c.json({ error: 'Not found' }, 404)

  await db.update(chatSessions).set({ title, updatedAt: new Date() }).where(eq(chatSessions.id, id))

  return c.json({ ok: true })
})

historyRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const session = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId))).get()

  if (!session) return c.json({ error: 'Not found' }, 404)

  await db.delete(chatSessions).where(eq(chatSessions.id, id))

  return c.json({ ok: true })
})
