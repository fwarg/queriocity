import { Hono } from 'hono'
import { db, chatSessions, messages, spaces, spaceMemories } from '../lib/db.ts'
import { eq, and, desc, ne } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { extractMemoriesPostHoc } from '../lib/memory.ts'

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

historyRouter.patch('/:id', zValidator('json', z.object({
  title: z.string().min(1).max(200).optional(),
  spaceId: z.string().uuid().nullable().optional(),
})), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const session = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId))).get()

  if (!session) return c.json({ error: 'Not found' }, 404)

  const update: Partial<typeof chatSessions.$inferInsert> = { updatedAt: new Date() }
  if (body.title !== undefined) update.title = body.title
  if (body.spaceId !== undefined) {
    if (body.spaceId !== null) {
      const space = await db.select().from(spaces).where(and(eq(spaces.id, body.spaceId), eq(spaces.userId, userId))).get()
      if (!space) return c.json({ error: 'Space not found' }, 404)
    }
    update.spaceId = body.spaceId
  }

  await db.update(chatSessions).set(update).where(eq(chatSessions.id, id))

  // Migrate auto memories when chat changes space
  if (body.spaceId !== undefined && body.spaceId !== session.spaceId) {
    const autoMemoriesFilter = and(eq(spaceMemories.sessionId, id), ne(spaceMemories.source, 'manual'))
    if (body.spaceId === null) {
      await db.delete(spaceMemories).where(autoMemoriesFilter)
    } else if (session.spaceId) {
      await db.update(spaceMemories).set({ spaceId: body.spaceId }).where(autoMemoriesFilter)
    } else {
      // Newly assigned to a space — retroactively extract memories from conversation
      const msgs = await db.select().from(messages).where(eq(messages.sessionId, id))
      const userContent = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n\n')
      const assistantContent = msgs.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n')
      if (userContent) {
        extractMemoriesPostHoc(body.spaceId, id, userContent, assistantContent)
          .catch(e => console.error('[memory] retroactive extraction failed:', e))
      }
    }
  }

  return c.json({ ok: true })
})

historyRouter.post('/:id/recreate-memories', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const session = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId))).get()

  if (!session) return c.json({ error: 'Not found' }, 404)
  if (!session.spaceId) return c.json({ error: 'Chat is not in a space' }, 400)

  await db.delete(spaceMemories).where(and(eq(spaceMemories.sessionId, id), ne(spaceMemories.source, 'manual')))

  const msgs = await db.select().from(messages).where(eq(messages.sessionId, id))
  const userContent = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n\n')
  const assistantContent = msgs.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n')
  if (userContent) {
    extractMemoriesPostHoc(session.spaceId, id, userContent, assistantContent)
      .catch(e => console.error('[memory] recreate extraction failed:', e))
  }

  return c.json({ ok: true })
})

historyRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const session = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId))).get()

  if (!session) return c.json({ error: 'Not found' }, 404)

  await db.delete(spaceMemories).where(and(eq(spaceMemories.sessionId, id), ne(spaceMemories.source, 'manual')))
  await db.delete(chatSessions).where(eq(chatSessions.id, id))

  return c.json({ ok: true })
})
