import { Hono } from 'hono'
import { db, chatSessions, messages } from '../lib/db.ts'
import { eq, and } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth.ts'

export const historyRouter = new Hono()

historyRouter.use('*', authMiddleware)

historyRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const sessions = await db.select().from(chatSessions)
    .where(eq(chatSessions.userId, userId))

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

historyRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const session = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId))).get()

  if (!session) return c.json({ error: 'Not found' }, 404)

  await db.delete(chatSessions).where(eq(chatSessions.id, id))

  return c.json({ ok: true })
})
