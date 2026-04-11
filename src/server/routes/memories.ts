import { Hono } from 'hono'
import { db, spaces, spaceMemories } from '../lib/db.ts'
import { eq, and } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { getSpaceMemories, saveMemory } from '../lib/memory.ts'

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
