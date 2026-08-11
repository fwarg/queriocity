import { Hono } from 'hono'
import { db, sqlite, chatSessions, messages, spaces, spaceMemories, monitorRuns } from '../lib/db.ts'
import { eq, and, desc, ne, count, isNull, or, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { extractMemoriesPostHoc } from '../lib/memory.ts'
import { deleteSessionImages } from '../lib/image-store.ts'
import { canMoveChat } from '../lib/space-lock.ts'
import { deindexSession, indexSession } from '../lib/chat-indexer.ts'

export const historyRouter = new Hono<AppEnv>()

historyRouter.use('*', authMiddleware)

historyRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200)
  const offset = parseInt(c.req.query('offset') ?? '0')
  const sort = c.req.query('sort') === 'created' ? 'created' : 'updated'
  const orderCol = sort === 'created' ? chatSessions.createdAt : chatSessions.updatedAt
  // Optional server-side space filter. Without it the caller can only narrow whatever page it
  // already holds, so a space whose chats fall outside the most recent `limit` looks empty while
  // its chat count — computed over every chat — says otherwise.
  const spaceId = c.req.query('spaceId')
  // `locked` is joined in rather than derived client-side: the chat list is where chats are picked
  // and reassigned, so it has to show the lock without the client cross-referencing the space list.
  const baseQuery = db.select({
    id: chatSessions.id, title: chatSessions.title, spaceId: chatSessions.spaceId,
    locked: sql<number>`coalesce(${spaces.offline}, 0)`,
    createdAt: chatSessions.createdAt, updatedAt: chatSessions.updatedAt,
  })
    .from(chatSessions)
    .leftJoin(monitorRuns, eq(chatSessions.id, monitorRuns.sessionId))
    .leftJoin(spaces, eq(chatSessions.spaceId, spaces.id))
  const where = and(
    eq(chatSessions.userId, userId),
    or(isNull(monitorRuns.id), eq(chatSessions.graduated, 1)),
    ...(spaceId ? [eq(chatSessions.spaceId, spaceId)] : []),
  )
  const [items, totalRow] = await Promise.all([
    baseQuery.where(where).orderBy(desc(orderCol)).limit(limit).offset(offset),
    db.select({ total: count() }).from(chatSessions).leftJoin(monitorRuns, eq(chatSessions.id, monitorRuns.sessionId)).where(where).get(),
  ])
  return c.json({ items, total: totalRow?.total ?? 0 })
})

historyRouter.get('/search', async (c) => {
  const userId = c.get('userId') as string
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json([])
  const like = `%${q}%`
  const results = sqlite.prepare(`
    SELECT DISTINCT cs.id, cs.title, cs.user_id, cs.space_id, cs.created_at, cs.updated_at
    FROM chat_sessions cs
    LEFT JOIN monitor_runs mr ON mr.session_id = cs.id
    WHERE cs.user_id = ? AND (mr.id IS NULL OR cs.graduated = 1) AND cs.title LIKE ? COLLATE NOCASE
    UNION
    SELECT DISTINCT cs.id, cs.title, cs.user_id, cs.space_id, cs.created_at, cs.updated_at
    FROM chat_sessions cs
    JOIN messages m ON m.session_id = cs.id
    LEFT JOIN monitor_runs mr ON mr.session_id = cs.id
    WHERE cs.user_id = ? AND (mr.id IS NULL OR cs.graduated = 1) AND m.content LIKE ? COLLATE NOCASE
    ORDER BY cs.updated_at DESC LIMIT 100
  `).all(userId, like, userId, like)
  return c.json(results)
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
    // A chat in a locked space read its documents under a promise of no egress; moving it to a
    // space that still has web access breaks that. `null` is the most permissive destination here,
    // not the safest — a chat with no space is an ordinary chat. Its auto-memories travel with it
    // below, so this covers those too. Moving *into* a locked space only tightens, and is allowed.
    if (!await canMoveChat(session.spaceId, body.spaceId)) {
      return c.json({
        error: 'This chat is in a locked space and can only be moved to another locked space.',
      }, 409)
    }
    update.spaceId = body.spaceId
  }

  await db.update(chatSessions).set(update).where(eq(chatSessions.id, id))

  // Migrate auto memories when chat changes space
  if (body.spaceId !== undefined && body.spaceId !== session.spaceId) {
    const autoMemoriesFilter = and(eq(spaceMemories.sessionId, id), ne(spaceMemories.source, 'manual'))
    if (body.spaceId === null) {
      deindexSession(id)
      await db.delete(spaceMemories).where(autoMemoriesFilter)
    } else if (session.spaceId) {
      // Moving between spaces — chat_chunks join through chat_sessions so no reindex needed
      await db.update(spaceMemories).set({ spaceId: body.spaceId }).where(autoMemoriesFilter)
    } else {
      // Newly assigned to a space — retroactively extract memories and index chat history
      const msgs = await db.select().from(messages).where(eq(messages.sessionId, id))
      const userContent = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n\n')
      const assistantContent = msgs.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n')
      if (userContent) {
        extractMemoriesPostHoc(body.spaceId, id, userContent, assistantContent)
          .catch(e => console.error('[memory] retroactive extraction failed:', e))
      }
      indexSession(id).catch(e => console.error('[chat-index] retroactive index failed:', e))
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
  indexSession(id).catch(e => console.error('[chat-index] reindex failed:', e))

  return c.json({ ok: true })
})

historyRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const session = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId))).get()

  if (!session) return c.json({ error: 'Not found' }, 404)

  const msgs = await db.select({ content: messages.content }).from(messages).where(eq(messages.sessionId, id))
  deindexSession(id)
  await db.delete(spaceMemories).where(and(eq(spaceMemories.sessionId, id), ne(spaceMemories.source, 'manual')))
  await db.delete(chatSessions).where(eq(chatSessions.id, id))
  deleteSessionImages(msgs.map(m => m.content)).catch(e => console.error('[image] cleanup failed:', e))

  return c.json({ ok: true })
})
