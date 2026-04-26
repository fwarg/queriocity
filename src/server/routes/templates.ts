import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db, customTemplates } from '../lib/db.ts'
import { eq, and, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'

export const templatesRouter = new Hono<AppEnv>()
templatesRouter.use('*', authMiddleware)

templatesRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await db.select().from(customTemplates)
    .where(eq(customTemplates.userId, userId))
    .orderBy(desc(customTemplates.createdAt))
  return c.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    promptText: r.promptText,
    suggestedMode: r.suggestedMode,
    createdAt: Math.floor((r.createdAt as Date).getTime() / 1000),
  })))
})

const templateBody = z.object({
  name: z.string().min(1).max(100),
  promptText: z.string().min(1).max(10000),
  suggestedMode: z.enum(['flash', 'balanced', 'thorough', 'image']).default('balanced'),
  description: z.string().max(200).optional(),
})

templatesRouter.post('/', zValidator('json', templateBody), async (c) => {
  const userId = c.get('userId') as string
  const { name, promptText, suggestedMode, description } = c.req.valid('json')
  const now = new Date()
  const id = randomUUID()
  await db.insert(customTemplates).values({
    id, userId, name, promptText, suggestedMode,
    description: description ?? null,
    createdAt: now, updatedAt: now,
  })
  return c.json({
    id, name, promptText, suggestedMode,
    description: description ?? undefined,
    createdAt: Math.floor(now.getTime() / 1000),
  }, 201)
})

templatesRouter.patch('/:id', zValidator('json', templateBody.partial()), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = c.req.valid('json')
  const existing = await db.select().from(customTemplates)
    .where(and(eq(customTemplates.id, id), eq(customTemplates.userId, userId))).get()
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.update(customTemplates).set({ ...body, updatedAt: new Date() })
    .where(eq(customTemplates.id, id))
  return c.json({ ok: true })
})

templatesRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = await db.select().from(customTemplates)
    .where(and(eq(customTemplates.id, id), eq(customTemplates.userId, userId))).get()
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.delete(customTemplates).where(eq(customTemplates.id, id))
  return c.json({ ok: true })
})
