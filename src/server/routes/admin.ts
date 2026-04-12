import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { generateText, embed } from 'ai'
import { db, users, invites, getAppSetting, setAppSetting } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, adminMiddleware, type AppEnv } from '../middleware/auth.ts'
import { getChatModel, getSmallModel, getThinkingModel, getEmbeddingModel } from '../lib/llm.ts'
import { rerank, rerankEnabled } from '../lib/reranker.ts'

export const adminRouter = new Hono<AppEnv>()

adminRouter.use('*', authMiddleware)
adminRouter.use('*', adminMiddleware)

adminRouter.get('/settings', async (c) => {
  const [memoryTokenBudget, dreamHour, dreamThreshold, dreamTarget, memoryExtractChars, rerankTopN, attachmentChars] = await Promise.all([
    getAppSetting('memory_token_budget', '1000').then(Number),
    getAppSetting('dream_hour', '-1').then(Number),
    getAppSetting('dream_threshold', '1500').then(Number),
    getAppSetting('dream_target', '700').then(Number),
    getAppSetting('memory_extract_chars', '6000').then(Number),
    getAppSetting('rerank_top_n', '15').then(Number),
    getAppSetting('attachment_chars', '20000').then(Number),
  ])
  return c.json({ memoryTokenBudget, dreamHour, dreamThreshold, dreamTarget, memoryExtractChars, rerankTopN, attachmentChars })
})

adminRouter.patch('/settings', zValidator('json', z.object({
  memoryTokenBudget: z.number().int().min(100).max(10000).optional(),
  dreamHour: z.number().int().min(-1).max(23).optional(),
  dreamThreshold: z.number().int().min(100).max(50000).optional(),
  dreamTarget: z.number().int().min(100).max(50000).optional(),
  memoryExtractChars: z.number().int().min(500).max(100000).optional(),
  rerankTopN: z.number().int().min(1).max(100).optional(),
  attachmentChars: z.number().int().min(1000).max(500000).optional(),
})), async (c) => {
  const body = c.req.valid('json')
  if (body.dreamTarget != null && body.dreamThreshold != null && body.dreamTarget > body.dreamThreshold)
    return c.json({ error: 'dreamTarget must be <= dreamThreshold' }, 400)
  if (body.dreamThreshold != null && body.memoryTokenBudget != null && body.dreamThreshold > body.memoryTokenBudget)
    return c.json({ error: 'dreamThreshold must be <= memoryTokenBudget' }, 400)
  const ops: Promise<void>[] = []
  if (body.memoryTokenBudget != null) ops.push(setAppSetting('memory_token_budget', String(body.memoryTokenBudget)))
  if (body.dreamHour != null) ops.push(setAppSetting('dream_hour', String(body.dreamHour)))
  if (body.dreamThreshold != null) ops.push(setAppSetting('dream_threshold', String(body.dreamThreshold)))
  if (body.dreamTarget != null) ops.push(setAppSetting('dream_target', String(body.dreamTarget)))
  if (body.memoryExtractChars != null) ops.push(setAppSetting('memory_extract_chars', String(body.memoryExtractChars)))
  if (body.rerankTopN != null) ops.push(setAppSetting('rerank_top_n', String(body.rerankTopN)))
  if (body.attachmentChars != null) ops.push(setAppSetting('attachment_chars', String(body.attachmentChars)))
  await Promise.all(ops)
  return c.json({ ok: true })
})

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
  const rerankModel = process.env.RERANK_MODEL

  await testChat('chat', chatModel, getChatModel)
  await testChat('small', smallModel, getSmallModel)
  if (thinkingModel) {
    await testChat('thinking', thinkingModel, getThinkingModel, 2000)
  } else {
    results.push({ role: 'thinking', model: '(not configured — uses chat)', ok: true, ms: 0, info: 'skipped' })
  }
  await testEmbed(embedModel)

  if (rerankEnabled && rerankModel) {
    const t = performance.now()
    try {
      const docs = ['Paris is the capital of France', 'Berlin is the capital of Germany']
      const indices = await rerank('capital of France', docs, 2)
      const ok = indices[0] === 0
      results.push({ role: 'rerank', model: rerankModel, ok, ms: Math.round(performance.now() - t), info: ok ? `top result correct` : `unexpected order: ${indices}` })
    } catch (e: any) {
      results.push({ role: 'rerank', model: rerankModel, ok: false, ms: Math.round(performance.now() - t), info: String(e?.message ?? e).slice(0, 120) })
    }
  } else {
    results.push({ role: 'rerank', model: '(not configured)', ok: true, ms: 0, info: 'skipped' })
  }

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
