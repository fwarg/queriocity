import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { db, spaces, spaceMemories, chatSessions, messages } from '../lib/db.ts'
import { eq, and, ne } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { getSpaceMemories, saveMemory, compactSpaceMemories, extractMemoriesPostHoc } from '../lib/memory.ts'
import { getAppSetting } from '../lib/db.ts'

export const memoriesRouter = new Hono<AppEnv>()

memoriesRouter.use('*', authMiddleware)

/** Verify space belongs to the user, return 404 otherwise. */
async function verifySpaceOwner(spaceId: string, userId: string) {
  return db.select().from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.userId, userId))).get()
}

memoriesRouter.get('/:spaceId/memories', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const memories = await getSpaceMemories(spaceId)
  return c.json(memories)
})

memoriesRouter.post('/:spaceId/memories', zValidator('json', z.object({
  content: z.string().min(1).max(500),
})), async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const { content } = c.req.valid('json')
  const id = await saveMemory(spaceId, content, 'manual')
  const memory = await db.select().from(spaceMemories).where(eq(spaceMemories.id, id)).get()
  return c.json(memory, 201)
})

memoriesRouter.patch('/:spaceId/memories/:id', zValidator('json', z.object({
  content: z.string().min(1).max(500),
})), async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  const id = c.req.param('id')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)

  const memory = await db.select().from(spaceMemories)
    .where(and(eq(spaceMemories.id, id), eq(spaceMemories.spaceId, spaceId))).get()
  if (!memory) return c.json({ error: 'Not found' }, 404)

  await db.update(spaceMemories).set({ content: c.req.valid('json').content, updatedAt: new Date() })
    .where(eq(spaceMemories.id, id))
  return c.json({ ok: true })
})

memoriesRouter.delete('/:spaceId/memories/:id', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  const id = c.req.param('id')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)

  const memory = await db.select().from(spaceMemories)
    .where(and(eq(spaceMemories.id, id), eq(spaceMemories.spaceId, spaceId))).get()
  if (!memory) return c.json({ error: 'Not found' }, 404)

  await db.delete(spaceMemories).where(eq(spaceMemories.id, id))
  return c.json({ ok: true })
})

memoriesRouter.post('/:spaceId/compact', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const targetTokens = parseInt(await getAppSetting('dream_target', '700'))
  const before = (await getSpaceMemories(spaceId)).length
  const compacted = await compactSpaceMemories(spaceId, targetTokens)
  const after = compacted ? (await getSpaceMemories(spaceId)).length : before
  return c.json({ ok: true, before, after, compacted })
})

memoriesRouter.post('/:spaceId/recreate-memories', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)

  // Delete all auto-extracted memories, keep manual ones
  await db.delete(spaceMemories)
    .where(and(eq(spaceMemories.spaceId, spaceId), ne(spaceMemories.source, 'manual')))

  const chats = await db.select().from(chatSessions).where(eq(chatSessions.spaceId, spaceId))
  const total = chats.length

  return streamSSE(c, async (stream) => {
    for (let i = 0; i < chats.length; i++) {
      const session = chats[i]
      const msgs = await db.select().from(messages).where(eq(messages.sessionId, session.id))
      const userContent = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n\n')
      const assistantContent = msgs.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n')
      if (userContent.trim()) {
        await extractMemoriesPostHoc(spaceId, session.id, userContent, assistantContent)
      }
      await stream.writeSSE({ data: JSON.stringify({ processed: i + 1, total }) })
    }
    await stream.writeSSE({ data: JSON.stringify({ done: true, total }) })
  })
})
