import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db, users, invites } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, adminMiddleware, type AppEnv } from '../middleware/auth.ts'

export const adminRouter = new Hono<AppEnv>()

adminRouter.use('*', authMiddleware)
adminRouter.use('*', adminMiddleware)

adminRouter.get('/users', async (c) => {
  const list = await db.select({
    id: users.id,
    email: users.email,
    name: users.name,
    role: users.role,
    createdAt: users.createdAt,
  }).from(users)
  return c.json(list)
})

adminRouter.patch('/users/:id', zValidator('json', z.object({ role: z.enum(['user', 'admin']) })), async (c) => {
  const { id } = c.req.param()
  const { role } = c.req.valid('json')
  if (id === c.get('userId')) return c.json({ error: 'Cannot change your own role' }, 400)
  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, id))
  return c.json({ ok: true })
})

adminRouter.delete('/users/:id', async (c) => {
  const { id } = c.req.param()
  if (id === c.get('userId')) return c.json({ error: 'Cannot delete yourself' }, 400)
  await db.delete(users).where(eq(users.id, id))
  return c.json({ ok: true })
})

adminRouter.post('/invites', zValidator('json', z.object({ email: z.string().email().optional() })), async (c) => {
  const { email } = c.req.valid('json')
  const id = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  await db.insert(invites).values({ id, createdBy: c.get('userId'), email: email ?? null, createdAt: now, expiresAt })
  return c.json({ token: id, expiresAt })
})
