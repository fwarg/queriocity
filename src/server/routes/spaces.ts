import { Hono } from 'hono'
import { db, spaces, chatSessions, spaceMemories } from '../lib/db.ts'
import { eq, and, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { randomUUID } from 'crypto'

export const spacesRouter = new Hono<AppEnv>()

spacesRouter.use('*', authMiddleware)

spacesRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      createdAt: spaces.createdAt,
      chatCount: sql<number>`(SELECT count(*) FROM chat_sessions WHERE space_id = ${spaces.id})`,
      memoryCount: sql<number>`(SELECT count(*) FROM space_memories WHERE space_id = ${spaces.id})`,
    })
    .from(spaces)
    .where(eq(spaces.userId, userId))
    .orderBy(spaces.createdAt)
  return c.json(rows.map(r => ({ ...r, createdAt: r.createdAt instanceof Date ? Math.floor(r.createdAt.getTime() / 1000) : r.createdAt })))
})

spacesRouter.post('/', zValidator('json', z.object({ name: z.string().min(1).max(100) })), async (c) => {
  const userId = c.get('userId') as string
  const { name } = c.req.valid('json')
  const now = new Date()
  const id = randomUUID()
  await db.insert(spaces).values({ id, name, userId, createdAt: now, updatedAt: now })
  return c.json({ id, name, chatCount: 0, memoryCount: 0, createdAt: Math.floor(now.getTime() / 1000) }, 201)
})

spacesRouter.patch('/:id', zValidator('json', z.object({ name: z.string().min(1).max(100) })), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const { name } = c.req.valid('json')

  const space = await db.select().from(spaces).where(and(eq(spaces.id, id), eq(spaces.userId, userId))).get()
  if (!space) return c.json({ error: 'Not found' }, 404)

  await db.update(spaces).set({ name, updatedAt: new Date() }).where(eq(spaces.id, id))
  return c.json({ ok: true })
})

spacesRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const space = await db.select().from(spaces).where(and(eq(spaces.id, id), eq(spaces.userId, userId))).get()
  if (!space) return c.json({ error: 'Not found' }, 404)

  await db.delete(spaces).where(eq(spaces.id, id))
  return c.json({ ok: true })
})
