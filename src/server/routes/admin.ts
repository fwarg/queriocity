import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { generateText, embed } from 'ai'
import { db, users, invites, chatSessions, spaces, spaceMemories, userMemories, uploadedFiles, authCredentials, getAppSetting, setAppSetting, bumpTokenVersion } from '../lib/db.ts'
import { eq, desc } from 'drizzle-orm'
import { indexSession, deindexSession } from '../lib/chat-indexer.ts'
import { EMBED_MAX_INPUT_CHARS, SMALL_MODEL_INPUT_CHARS } from '../lib/llm.ts'
import { DEFAULT_MAX_URL_CONTEXT_CHARS, MIN_URL_CONTEXT_CHARS, SCRAPE_MAX_CHARS } from '../lib/fetch-url.ts'
import { randomUUID, randomInt } from 'crypto'
import { hashPassword } from '../lib/auth.ts'
import { authMiddleware, adminMiddleware, type AppEnv } from '../middleware/auth.ts'
import { getChatModel, getSmallModel, getThinkingModel, getEmbeddingModel } from '../lib/llm.ts'
import { rerank, rerankEnabled } from '../lib/reranker.ts'
import { runDream, deleteMemoryEmbeddings } from '../lib/memory.ts'
import { deleteFileChunks } from '../lib/vector-cleanup.ts'
import { deleteUserImages } from '../lib/image-store.ts'

/** Random temporary password that satisfies validatePassword's complexity rules. */
function generateTempPassword(): string {
  const pick = (set: string, n: number) =>
    Array.from({ length: n }, () => set[randomInt(set.length)]).join('')
  const chars = pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 3) + pick('abcdefghijkmnpqrstuvwxyz', 5)
    + pick('23456789', 3) + pick('!@#$%&*?', 2)
  // Shuffle so the character classes aren't in a predictable order.
  return chars.split('').sort(() => randomInt(2) - 0.5).join('')
}

export const adminRouter = new Hono<AppEnv>()

adminRouter.use('*', authMiddleware)
adminRouter.use('*', adminMiddleware)

adminRouter.get('/settings', async (c) => {
  const [memoryTokenBudget, userMemoryTokenBudget, dreamHour, dreamThreshold, dreamTarget, dreamDeep, memoryExtractChars, rerankTopN, ragTopK, ragMinRelevance, attachmentChars, spaceRagBudget, queryReformulation, rssFeedCharsBudget, fetchMaxPages, fetchMaxUrlContextChars, fetchSummarizeOverflow, compressHistoryOverflow, resourceSummary] = await Promise.all([
    getAppSetting('memory_token_budget', '1000').then(Number),
    getAppSetting('user_memory_token_budget', '300').then(Number),
    getAppSetting('dream_hour', '-1').then(Number),
    getAppSetting('dream_threshold', '1500').then(Number),
    getAppSetting('dream_target', '700').then(Number),
    getAppSetting('dream_deep', 'false').then(v => v === 'true'),
    getAppSetting('memory_extract_chars', '6000').then(Number),
    getAppSetting('rerank_top_n', '15').then(Number),
    getAppSetting('rag_top_k', '15').then(Number),
    getAppSetting('rag_min_relevance', '0').then(Number),
    getAppSetting('attachment_chars', '20000').then(Number),
    getAppSetting('space_rag_budget', '500').then(Number),
    getAppSetting('query_reformulation', 'true').then(v => v === 'true'),
    getAppSetting('rss_feed_chars_budget', '50000').then(Number),
    getAppSetting('fetch_max_pages', '8').then(Number),
    getAppSetting('fetch_max_url_context_chars', String(DEFAULT_MAX_URL_CONTEXT_CHARS)).then(Number),
    getAppSetting('fetch_summarize_overflow', 'false').then(v => v === 'true'),
    getAppSetting('compress_history_overflow', 'false').then(v => v === 'true'),
    getAppSetting('resource_summary', 'true').then(v => v === 'true'),
  ])
  // Read-only, derived from the model context env vars. Two of the settings above are silently
  // clamped by these at use time, so the panel needs them to show what a value actually does
  // rather than what was typed.
  return c.json({ memoryTokenBudget, userMemoryTokenBudget, dreamHour, dreamThreshold, dreamTarget, dreamDeep, memoryExtractChars, rerankTopN, ragTopK, ragMinRelevance, attachmentChars, spaceRagBudget, queryReformulation, rssFeedCharsBudget, fetchMaxPages, fetchMaxUrlContextChars, fetchSummarizeOverflow, compressHistoryOverflow, resourceSummary, limits: { smallModelInputChars: SMALL_MODEL_INPUT_CHARS, embedInputChars: EMBED_MAX_INPUT_CHARS, scrapeMaxChars: SCRAPE_MAX_CHARS, minUrlContextChars: MIN_URL_CONTEXT_CHARS } })
})

adminRouter.patch('/settings', zValidator('json', z.object({
  memoryTokenBudget: z.number().int().min(100).max(10000).optional(),
  userMemoryTokenBudget: z.number().int().min(0).max(5000).optional(),
  dreamHour: z.number().int().min(-1).max(23).optional(),
  dreamThreshold: z.number().int().min(100).max(50000).optional(),
  dreamTarget: z.number().int().min(100).max(50000).optional(),
  dreamDeep: z.boolean().optional(),
  memoryExtractChars: z.number().int().min(500).max(100000).optional(),
  rerankTopN: z.number().int().min(1).max(100).optional(),
  ragTopK: z.number().int().min(1).max(100).optional(),
  ragMinRelevance: z.number().min(0).max(1).optional(),
  attachmentChars: z.number().int().min(1000).max(500000).optional(),
  spaceRagBudget: z.number().int().min(0).max(10000).optional(),
  queryReformulation: z.boolean().optional(),
  rssFeedCharsBudget: z.number().int().min(5000).max(500000).optional(),
  fetchMaxPages: z.number().int().min(0).max(50).optional(),
  fetchMaxUrlContextChars: z.number().int().min(MIN_URL_CONTEXT_CHARS).max(SCRAPE_MAX_CHARS).optional(),
  fetchSummarizeOverflow: z.boolean().optional(),
  compressHistoryOverflow: z.boolean().optional(),
  resourceSummary: z.boolean().optional(),
})), async (c) => {
  const body = c.req.valid('json')
  if (body.dreamTarget != null && body.dreamThreshold != null && body.dreamTarget > body.dreamThreshold)
    return c.json({ error: 'dreamTarget must be <= dreamThreshold' }, 400)
  if (body.dreamThreshold != null && body.memoryTokenBudget != null && body.dreamThreshold > body.memoryTokenBudget)
    return c.json({ error: 'dreamThreshold must be <= memoryTokenBudget' }, 400)
  const ops: Promise<void>[] = []
  if (body.memoryTokenBudget != null) ops.push(setAppSetting('memory_token_budget', String(body.memoryTokenBudget)))
  if (body.userMemoryTokenBudget != null) ops.push(setAppSetting('user_memory_token_budget', String(body.userMemoryTokenBudget)))
  if (body.dreamHour != null) ops.push(setAppSetting('dream_hour', String(body.dreamHour)))
  if (body.dreamThreshold != null) ops.push(setAppSetting('dream_threshold', String(body.dreamThreshold)))
  if (body.dreamTarget != null) ops.push(setAppSetting('dream_target', String(body.dreamTarget)))
  if (body.dreamDeep != null) ops.push(setAppSetting('dream_deep', String(body.dreamDeep)))
  if (body.memoryExtractChars != null) ops.push(setAppSetting('memory_extract_chars', String(body.memoryExtractChars)))
  if (body.rerankTopN != null) ops.push(setAppSetting('rerank_top_n', String(body.rerankTopN)))
  if (body.ragTopK != null) ops.push(setAppSetting('rag_top_k', String(body.ragTopK)))
  if (body.ragMinRelevance != null) ops.push(setAppSetting('rag_min_relevance', String(body.ragMinRelevance)))
  if (body.attachmentChars != null) ops.push(setAppSetting('attachment_chars', String(body.attachmentChars)))
  if (body.spaceRagBudget != null) ops.push(setAppSetting('space_rag_budget', String(body.spaceRagBudget)))
  if (body.queryReformulation != null) ops.push(setAppSetting('query_reformulation', String(body.queryReformulation)))
  if (body.rssFeedCharsBudget != null) ops.push(setAppSetting('rss_feed_chars_budget', String(body.rssFeedCharsBudget)))
  if (body.fetchMaxPages != null) ops.push(setAppSetting('fetch_max_pages', String(body.fetchMaxPages)))
  if (body.fetchMaxUrlContextChars != null) ops.push(setAppSetting('fetch_max_url_context_chars', String(body.fetchMaxUrlContextChars)))
  if (body.fetchSummarizeOverflow != null) ops.push(setAppSetting('fetch_summarize_overflow', String(body.fetchSummarizeOverflow)))
  if (body.compressHistoryOverflow != null) ops.push(setAppSetting('compress_history_overflow', String(body.compressHistoryOverflow)))
  if (body.resourceSummary != null) ops.push(setAppSetting('resource_summary', String(body.resourceSummary)))
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
  // Their existing cookie carries the old role — invalidate it so the change takes effect now.
  await bumpTokenVersion(id)
  return c.json({ ok: true })
})

/** Issues a temporary password for a locked-out user. Returned once, in the response body —
 *  the admin passes it on out-of-band, and the user is forced to replace it at next login. */
adminRouter.post('/users/:id/reset-password', async (c) => {
  const { id } = c.req.param()
  const cred = await db.select().from(authCredentials).where(eq(authCredentials.userId, id)).get()
  if (!cred) return c.json({ error: 'Not found' }, 404)

  const tempPassword = generateTempPassword()
  await db.update(authCredentials)
    .set({ passwordHash: await hashPassword(tempPassword), mustChangePassword: true })
    .where(eq(authCredentials.userId, id))
  // Any session they still have open must not survive an admin-forced reset.
  await bumpTokenVersion(id)

  console.log(`  [admin] password reset for user ${id} by ${c.get('userId')}`)
  return c.json({ tempPassword })
})

/** Deleting a user takes everything of theirs that the schema cannot.
 *
 *  `db.delete(users)` cascades the tables with foreign keys — sessions, messages, uploads, spaces,
 *  memories. It reaches none of the vec0 tables, which cannot carry one, nor `chat_chunk_meta` and
 *  `file_chunk_meta`, which hold a verbatim copy of every conversation and document. Nor the PNGs
 *  on disk. Deleting the account has to mean deleting the data, so this mirrors what the chat,
 *  file and space delete routes each already do for their own scope. */
adminRouter.delete('/users/:id', async (c) => {
  const { id } = c.req.param()
  if (id === c.get('userId')) return c.json({ error: 'Cannot delete yourself' }, 400)

  // Collected before the cascade, while the rows that name them still exist.
  const sessionIds = (await db.select({ id: chatSessions.id }).from(chatSessions)
    .where(eq(chatSessions.userId, id)).all()).map(r => r.id)
  const fileIds = (await db.select({ id: uploadedFiles.id }).from(uploadedFiles)
    .where(eq(uploadedFiles.userId, id)).all()).map(r => r.id)
  // Space and user memories share memory_embeddings, keyed by memory id, so one list covers both.
  const memoryIds = [
    ...(await db.select({ id: spaceMemories.id }).from(spaceMemories)
      .innerJoin(spaces, eq(spaceMemories.spaceId, spaces.id))
      .where(eq(spaces.userId, id)).all()).map(r => r.id),
    ...(await db.select({ id: userMemories.id }).from(userMemories)
      .where(eq(userMemories.userId, id)).all()).map(r => r.id),
  ]
  for (const sessionId of sessionIds) deindexSession(sessionId)
  for (const fileId of fileIds) deleteFileChunks(fileId)
  deleteMemoryEmbeddings(memoryIds)
  // The whole folder, not the images their messages happen to reference: anything already
  // orphaned by a regenerate or an aborted turn would otherwise survive the account itself.
  await deleteUserImages(id)

  await db.delete(users).where(eq(users.id, id))
  console.log(`  [admin] deleted user ${id} by ${c.get('userId')} — ${sessionIds.length} chat(s), ${fileIds.length} file(s), ${memoryIds.length} memor${memoryIds.length === 1 ? 'y' : 'ies'}`)
  return c.json({ ok: true })
})

adminRouter.post('/dream/run', async (c) => {
  console.log(`  [dream] manual trigger by user ${c.get('userId')}`)
  runDream().catch(e => console.error('[dream] failed:', e))
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
        maxOutputTokens: maxTokens,
      })
      results.push({ role, model: modelName, ok: true, ms: Math.round(performance.now() - t), info: text.trim().slice(0, 80) })
    } catch (e: unknown) {
      results.push({ role, model: modelName, ok: false, ms: Math.round(performance.now() - t), info: String(e instanceof Error ? e.message : e).slice(0, 120) })
    }
  }

  async function testEmbed(modelName: string) {
    const t = performance.now()
    try {
      const { embedding } = await embed({ model: getEmbeddingModel(), value: 'hello world' })
      results.push({ role: 'embed', model: modelName, ok: true, ms: Math.round(performance.now() - t), info: `dim=${embedding.length}` })
    } catch (e: unknown) {
      results.push({ role: 'embed', model: modelName, ok: false, ms: Math.round(performance.now() - t), info: String(e instanceof Error ? e.message : e).slice(0, 120) })
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
    } catch (e: unknown) {
      results.push({ role: 'rerank', model: rerankModel, ok: false, ms: Math.round(performance.now() - t), info: String(e instanceof Error ? e.message : e).slice(0, 120) })
    }
  } else {
    results.push({ role: 'rerank', model: '(not configured)', ok: true, ms: 0, info: 'skipped' })
  }

  return c.json(results)
})

adminRouter.post('/reindex-chats', async (c) => {
  const sessions = await db.select({ id: chatSessions.id }).from(chatSessions)
  console.log(`[admin] reindex-chats triggered: ${sessions.length} sessions`)
  ;(async () => {
    let done = 0, failed = 0
    for (const { id } of sessions) {
      try { await indexSession(id); done++ }
      catch (e) { failed++; console.error(`[admin] reindex-chats failed for session ${id}:`, e) }
    }
    console.log(`[admin] reindex-chats complete: ${done} ok, ${failed} failed`)
  })().catch(e => console.error('[admin] reindex-chats error:', e))
  return c.json({ ok: true, sessions: sessions.length })
})

adminRouter.post('/invites',zValidator('json', z.object({ email: z.string().email().optional() })), async (c) => {
  const { email } = c.req.valid('json')
  const id = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  await db.insert(invites).values({ id, createdBy: c.get('userId'), email: email ?? null, createdAt: now, expiresAt })
  return c.json({ token: id, expiresAt })
})

adminRouter.get('/invites', async (c) => {
  const rows = await db.select().from(invites).orderBy(desc(invites.createdAt))
  return c.json(rows.map(i => ({
    token: i.id,
    email: i.email,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    usedAt: i.usedAt,
  })))
})

adminRouter.delete('/invites/:token', async (c) => {
  const { token } = c.req.param()
  const invite = await db.select().from(invites).where(eq(invites.id, token)).get()
  if (!invite) return c.json({ error: 'Not found' }, 404)
  await db.delete(invites).where(eq(invites.id, token))
  return c.json({ ok: true })
})
