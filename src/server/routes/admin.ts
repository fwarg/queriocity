import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { generateText, embed } from 'ai'
import { db, users, invites } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, adminMiddleware, type AppEnv } from '../middleware/auth.ts'
import { getChatModel, getSmallModel, getThinkingModel, getEmbeddingModel } from '../lib/llm.ts'

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

adminRouter.get('/models-test', async (c) => {
  type Result = { role: string; model: string; ok: boolean; ms: number; info: string }
  const results: Result[] = []

  async function testChat(role: string, modelName: string, getModel: () => ReturnType<typeof getChatModel>, maxTokens = 50) {
    const t = performance.now()
    try {
      const { text } = await generateText({
        model: getModel(),
        messages: [{ role: 'user', content: 'Reply with one word: OK' }],
        maxTokens,
      })
      results.push({ role, model: modelName, ok: true, ms: Math.round(performance.now() - t), info: text.trim().slice(0, 80) })
    } catch (e: any) {
      results.push({ role, model: modelName, ok: false, ms: Math.round(performance.now() - t), info: String(e?.message ?? e).slice(0, 120) })
    }
  }

  async function testEmbed(modelName: string) {
    const t = performance.now()
    try {
      const { embedding } = await embed({ model: getEmbeddingModel(), value: 'hello world' })
      results.push({ role: 'embed', model: modelName, ok: true, ms: Math.round(performance.now() - t), info: `dim=${embedding.length}` })
    } catch (e: any) {
      results.push({ role: 'embed', model: modelName, ok: false, ms: Math.round(performance.now() - t), info: String(e?.message ?? e).slice(0, 120) })
    }
  }

  const chatModel = process.env.CHAT_MODEL ?? 'llama3.2'
  const smallModel = process.env.SMALL_MODEL ?? chatModel
  const thinkingModel = process.env.THINKING_MODEL
  const embedModel = process.env.EMBED_MODEL ?? 'nomic-embed-text'

  await testChat('chat', chatModel, getChatModel)
  await testChat('small', smallModel, getSmallModel)
  if (thinkingModel) {
    await testChat('thinking', thinkingModel, getThinkingModel, 2000)
  } else {
    results.push({ role: 'thinking', model: '(not configured — uses chat)', ok: true, ms: 0, info: 'skipped' })
  }
  await testEmbed(embedModel)

  return c.json(results)
})

adminRouter.post('/invites', zValidator('json', z.object({ email: z.string().email().optional() })), async (c) => {
  const { email } = c.req.valid('json')
  const id = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  await db.insert(invites).values({ id, createdBy: c.get('userId'), email: email ?? null, createdAt: now, expiresAt })
  return c.json({ token: id, expiresAt })
})
