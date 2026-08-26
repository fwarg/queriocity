import { Hono } from 'hono'
import { db, spaces, chatSessions, spaceMemories, spaceFiles, messages } from '../lib/db.ts'
import { eq, and, sql, count } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { randomUUID } from 'crypto'
import { canUnlock, describeContents, monitorsInSpace, sessionIdsInSpace } from '../lib/space-lock.ts'
import { deleteSessionImages } from '../lib/image-store.ts'
import { deindexSession } from '../lib/chat-indexer.ts'
import { deleteMemoryEmbeddings } from '../lib/memory.ts'

export const spacesRouter = new Hono<AppEnv>()

spacesRouter.use('*', authMiddleware)

/** Named once: four routes refuse the same thing, and they should say so identically. */
const NOT_LOCKABLE = 'A collection cannot be locked. Locking denies a chat web access, and a collection holds no chats — put confidential material in a locked space instead.'

spacesRouter.get('/', async (c) => {
  const userId = c.get('userId') as string

  const chatCountSq = db.select({ spaceId: chatSessions.spaceId, chatN: count().as('chat_n') })
    .from(chatSessions)
    .groupBy(chatSessions.spaceId)
    .as('cc')

  const memCountSq = db.select({ spaceId: spaceMemories.spaceId, memN: count().as('mem_n') })
    .from(spaceMemories)
    .groupBy(spaceMemories.spaceId)
    .as('mc')

  // A collection is counted by what it holds — resources — the way a space is counted by chats.
  const fileCountSq = db.select({ spaceId: spaceFiles.spaceId, fileN: count().as('file_n') })
    .from(spaceFiles)
    .groupBy(spaceFiles.spaceId)
    .as('fc')

  const rows = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      kind: spaces.kind,
      offline: spaces.offline,
      createdAt: spaces.createdAt,
      chatCount: sql<number>`coalesce(${chatCountSq.chatN}, 0)`,
      memoryCount: sql<number>`coalesce(${memCountSq.memN}, 0)`,
      resourceCount: sql<number>`coalesce(${fileCountSq.fileN}, 0)`,
    })
    .from(spaces)
    .leftJoin(chatCountSq, eq(spaces.id, chatCountSq.spaceId))
    .leftJoin(memCountSq, eq(spaces.id, memCountSq.spaceId))
    .leftJoin(fileCountSq, eq(spaces.id, fileCountSq.spaceId))
    .where(eq(spaces.userId, userId))
    .orderBy(spaces.createdAt)

  return c.json(rows.map(r => ({ ...r, createdAt: r.createdAt instanceof Date ? Math.floor(r.createdAt.getTime() / 1000) : r.createdAt })))
})

spacesRouter.post('/', zValidator('json', z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(['space', 'collection']).optional().default('space'),
  // Settable at creation so the recommended flow — lock the space *before* putting anything in it —
  // needs no second call, and so the lock is in place before the first document arrives.
  offline: z.boolean().optional().default(false),
})), async (c) => {
  const userId = c.get('userId') as string
  const { name, kind, offline } = c.req.valid('json')
  if (kind === 'collection' && offline) return c.json({ error: NOT_LOCKABLE }, 400)
  const now = new Date()
  const id = randomUUID()
  await db.insert(spaces).values({ id, name, userId, kind, offline, createdAt: now, updatedAt: now })
  return c.json({
    id, name, kind, offline,
    chatCount: 0, memoryCount: 0, resourceCount: 0,
    createdAt: Math.floor(now.getTime() / 1000),
  }, 201)
})

/** Name, lock state, and promoting a collection.
 *
 *  The lock is asymmetric on purpose — see canUnlock in lib/space-lock.ts — and so is the kind:
 *  a collection may become a space, never the reverse. */
spacesRouter.patch('/:id', zValidator('json', z.object({
  name: z.string().min(1).max(100).optional(),
  offline: z.boolean().optional(),
  kind: z.enum(['space', 'collection']).optional(),
})), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const { name, offline, kind } = c.req.valid('json')

  const space = await db.select().from(spaces).where(and(eq(spaces.id, id), eq(spaces.userId, userId))).get()
  if (!space) return c.json({ error: 'Not found' }, 404)

  // Locking denies a chat web search, URL fetching and image generation. A collection has no chats,
  // so there is nothing to deny and the flag would only be a claim the app does not keep.
  if (offline === true && space.kind === 'collection') return c.json({ error: NOT_LOCKABLE }, 400)

  // One-way: promoting only adds capabilities to a grouping that has none, and its tagged resources
  // are already in `space_files`, so nothing moves. Demoting would have to answer what happens to
  // the chats, memories and lock a space may hold — a question worth not having.
  if (kind === 'collection' && space.kind === 'space') {
    return c.json({ error: 'A space cannot be turned into a collection. Create a collection and tag its resources instead.' }, 400)
  }

  // Unlocking a space that still holds anything would hand web access back to chats and memories
  // built up while it was sealed. Refused with the contents named, so the UI can say what to clear.
  if (offline === false && space.offline) {
    const { ok, contents } = await canUnlock(id)
    if (!ok) {
      return c.json({
        error: `This space cannot be unlocked while it still holds ${describeContents(contents)}. Delete them first, or move them to another locked space.`,
        contents,
      }, 409)
    }
  }

  // The mirror of the rule monitors.ts enforces: a monitor may not be assigned to a locked space,
  // so a space holding one may not be locked either. Without this, locking is simply the other
  // way round the same door — the monitor keeps searching the web on schedule inside the space.
  if (offline === true && !space.offline) {
    const n = await monitorsInSpace(id)
    if (n > 0) {
      return c.json({
        error: `This space cannot be locked while ${n} monitor${n === 1 ? '' : 's'} still ${n === 1 ? 'runs' : 'run'} in it — monitors search the web on a schedule. Delete or reassign them first.`,
        monitors: n,
      }, 409)
    }
  }

  const update: Partial<typeof spaces.$inferInsert> = { updatedAt: new Date() }
  if (name !== undefined) update.name = name
  if (offline !== undefined) update.offline = offline
  if (kind !== undefined) update.kind = kind
  await db.update(spaces).set(update).where(eq(spaces.id, id))
  if (offline !== undefined && offline !== space.offline) {
    console.log(`  [space] ${id} ${offline ? 'locked (offline)' : 'unlocked'}`)
  }
  if (kind !== undefined && kind !== space.kind) console.log(`  [space] ${id} promoted to a space`)
  return c.json({ ok: true })
})

/** Deleting a locked space takes its chats with it.
 *
 *  `chat_sessions.space_id` is ON DELETE SET NULL, so the default behaviour would leave every chat
 *  behind as an ordinary unlocked one — the quietest way out of a locked space, since nothing about
 *  "delete space" suggests it touches the lock. The client confirms this before calling. */
spacesRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const space = await db.select().from(spaces).where(and(eq(spaces.id, id), eq(spaces.userId, userId))).get()
  if (!space) return c.json({ error: 'Not found' }, 404)

  let deletedChats = 0
  if (space.offline) {
    const sessionIds = await sessionIdsInSpace(id)
    for (const sessionId of sessionIds) {
      const rows = await db.select({ content: messages.content }).from(messages)
        .where(eq(messages.sessionId, sessionId)).all()
      await deleteSessionImages(rows.map(r => r.content))
      // Indexed chunks keep a verbatim copy of the conversation in chat_chunk_meta, and nothing in
      // the schema removes it — chat_chunks is a vec0 table. Skipping this left the document text
      // of a locked space on disk after the space was deleted, which is the one thing deleting it
      // is supposed to prevent.
      deindexSession(sessionId)
      // messages cascade from chat_sessions, so the session row is all that must go explicitly.
      await db.delete(chatSessions).where(eq(chatSessions.id, sessionId))
    }
    deletedChats = sessionIds.length
    if (deletedChats) console.log(`  [space] deleted ${deletedChats} chat(s) with locked space ${id}`)
  }

  // space_memories cascades from spaces, but memory_embeddings is vec0 and cannot, so collect the
  // ids while the rows still exist.
  const memoryIds = await db.select({ id: spaceMemories.id }).from(spaceMemories)
    .where(eq(spaceMemories.spaceId, id)).all()
  deleteMemoryEmbeddings(memoryIds.map(m => m.id))

  await db.delete(spaces).where(eq(spaces.id, id))
  return c.json({ ok: true, deletedChats })
})
