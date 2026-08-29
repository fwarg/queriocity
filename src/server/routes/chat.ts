import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { streamText, generateText, tool, stepCountIs } from 'ai'
import { runResearcher, maxStepsFor, type EgressApprovalRequest } from '../lib/researcher.ts'
import { runWriter } from '../lib/writer.ts'
import { drainResearcherStream, type SSEStream } from '../lib/researcher-stream.ts'
import { stepEvent, type ProgressStep } from '../lib/progress.ts'
import { FLASH_SYSTEM, FLASH_MAX_TOKENS, RESEARCHER_NOTES_CAP, EMPTY_ANSWER_MESSAGE, runSynthesisFallback } from '../lib/answer.ts'
import { reformulateLLM } from '../lib/reformulate.ts'
import { cacheKey, getCached, setCached } from '../lib/cache.ts'
import { db, chatSessions, messages, users, uploadedFiles, parseSettings, getAppSetting } from '../lib/db.ts'
import { eq, and, desc, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { readFile } from 'node:fs/promises'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { webSearch, webSearchMulti, type SearchResult, type EngineError, type SearchApiBudget } from '../lib/searxng.ts'
import { fetchUrlAllPages, processUrlsForContext, describeOutcome, DEFAULT_MAX_URL_CONTEXT_CHARS, type UrlOutcome, type ProcessedUrl } from '../lib/fetch-url.ts'
import { getFlashModel, getChatModel, getThinkingModelOrFallback, RESEARCH_MAX_TOKENS } from '../lib/llm.ts'
import { ThinkExtractor } from '../lib/think-extractor.ts'
import { findLeakedToolCall, stripLeakedToolCall, coerceNumericArgs } from '../lib/leaked-tool-call.ts'
import { CitationNormalizer } from '../lib/citation-normalizer.ts'
import { rerankSearchResults } from '../lib/reranker.ts'
import { buildMemoryBlock, buildChatFileBlock, buildCollectionBlock, extractMemoriesPostHoc, userMemoryBlockIfEnabled, joinMemoryBlocks } from '../lib/memory.ts'
import { ownedCollectionIds } from '../lib/files/collections.ts'
import { trimMessages, contextCharBudget, CONTEXT_RESERVE_FRACTION } from '../lib/trim-messages.ts'
import { indexContents, deindexContent } from '../lib/chat-indexer.ts'
import { ownsSpace, sessionOwnership } from '../lib/ownership.ts'
import { isSpaceLocked } from '../lib/space-lock.ts'
import { rateLimitByUser, chatLimiter, suggestLimiter } from '../lib/rate-limit.ts'
import {
  startRun, getRun, appendEvent, finishRun, waitForEvents,
  scheduleAbandon, cancelAbandon, stopRun, awaitApproval, settleApproval, approvalTimeLeft,
  APPROVAL_TIMEOUT_MS, type LiveRun,
} from '../lib/stream-buffer.ts'
import { IMAGE_API, imageFilePath, randomSeed, resolveSteps, saveGeneratedImage, deleteSupersededImages } from '../lib/image-store.ts'
import { imageBackend, compensateSteps, DEFAULT_EDIT_STRENGTH } from '../lib/image-api.ts'

/** Render settings used for each generated image, so an edit inherits them from its source.
 *
 *  An edit arrives as a follow-up like "change the fur to blue", which restates neither the quality
 *  tier nor the exclusions nor the seed — so without this every edit fell back to defaults, quietly
 *  rendering a draft image at balanced and dropping the negative prompt the generation had set.
 *
 *  Reusing the source's seed also keeps the edit closer to the original: measured over six seeds at
 *  strength 0.65, the source seed gave a mean pixel distance of 42 against 46-56 for random ones.
 *  The seed picks the noise layered onto the source, and the noise the source was built from
 *  disturbs it least.
 *
 *  Kept here rather than asked of the model, which rewrites the positive prompt faithfully and
 *  forgets everything else. Keyed by image URL rather than held per turn, because an edit almost
 *  always arrives as a later request with a fresh closure, and unlike the image URL — recovered by
 *  scanning message history — a tool argument leaves nothing to recover from.
 *
 *  In memory only: after a restart an edit simply falls back to defaults. */
interface RenderSettings {
  negativePrompt?: string
  steps: number
  seed: number
}

const renderByImage = new Map<string, RenderSettings>()
const MAX_REMEMBERED_RENDERS = 500

function rememberRender(url: string | undefined, settings: RenderSettings) {
  if (!url) return
  if (renderByImage.size >= MAX_REMEMBERED_RENDERS) renderByImage.clear()
  renderByImage.set(url, settings)
}

const KEEPALIVE_INTERVAL_MS = 15000
const SESSION_TITLE_MAX = 60

// Content is generously bounded rather than tightly: a user message can carry an inlined
// attachment, capped separately by the attachment_chars setting (admin max 500000).
const chatSchema = z.object({
  sessionId: z.string().optional(),
  spaceId: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(600_000),
  })).max(200),
  focusMode: z.enum(['flash', 'balanced', 'thorough', 'image']).default('balanced'),
  searchCategories: z.array(z.enum(['news', 'science', 'discussions', 'tech'])).optional(),
  includeFileIds: z.array(z.string()).optional(),
  includeMemoryIds: z.array(z.string()).optional(),
  /** Collections picked for this request only — they apply with or without a space. */
  collectionIds: z.array(z.string()).max(20).optional(),
  ephemeral: z.boolean().optional(),
  /** Re-answering the last question: replaces the previous answer instead of appending. */
  regenerate: z.boolean().optional(),
})

export const chatRouter = new Hono<AppEnv>()

chatRouter.use('*', authMiddleware)

chatRouter.post('/suggest', rateLimitByUser(suggestLimiter, 'suggest'), zValidator('json', z.object({ text: z.string().min(5).max(500) })), async (c) => {
  const { text } = c.req.valid('json')
  try {
    const { text: raw } = await generateText({
      model: getFlashModel(),
      system: 'Return a JSON array of exactly 3 short search query suggestions that complete or refine the user\'s partial input. Return ONLY the raw JSON array, no markdown, no explanation.',
      messages: [{ role: 'user', content: text }],
      maxOutputTokens: 120,
      abortSignal: AbortSignal.timeout(6000),
    })
    const match = raw.match(/\[[\s\S]*\]/)
    if (match) {
      const suggestions = JSON.parse(match[0])
      if (Array.isArray(suggestions)) {
        return c.json(suggestions.slice(0, 4).filter((s): s is string => typeof s === 'string'))
      }
    }
  } catch (e) {
    // Autocomplete is optional; a timeout is routine and doesn't warrant a full stack dump.
    console.warn(`  [suggest] skipped: ${e instanceof Error ? e.message : e}`)
  }
  return c.json([])
})

const RELATED_INPUT_CHARS = 1500
// Snippet kept per stored source so citation hover previews still work after a reload —
// short enough that it costs little in the sources JSON column.
const STORED_SNIPPET_CHARS = 300

/** Latest user message, the query every relevance decision is made against. */
const userQueryOf = (msgs: Array<{ role: string; content: string }>) =>
  [...msgs].reverse().find(m => m.role === 'user')?.content ?? ''

/** Token budget for the collections picked this request, or 0 when none are.
 *
 *  Reads `space_rag_budget` rather than adding a setting of its own: it is the same question — how
 *  many tokens of retrieved document may enter a prompt — and one knob is easier to reason about
 *  than two. Read only when collections are actually selected, so the usual request is unchanged. */
const collectionRagBudget = async (collections: string[]): Promise<number> =>
  collections.length ? Number(await getAppSetting('space_rag_budget', '500')) : 0

const toStoredSource = (r: SearchResult) => ({
  title: r.title,
  url: r.url,
  content: r.content ? r.content.slice(0, STORED_SNIPPET_CHARS) : undefined,
})

/** Suggests follow-up questions from a finished exchange. Best-effort: an empty array simply
 *  means no chips are shown, so a slow or unavailable small model costs nothing. */
chatRouter.post('/related', rateLimitByUser(suggestLimiter, 'related'), zValidator('json', z.object({
  question: z.string().min(1).max(2000),
  answer: z.string().min(1),
})), async (c) => {
  const { question, answer } = c.req.valid('json')
  try {
    const { text: raw } = await generateText({
      model: getFlashModel(),
      system: `Suggest 3 natural follow-up questions a curious reader would ask next after this exchange.
Each must be self-contained (no "it"/"that" referring to the previous answer), under 12 words, and explore something the answer did NOT already cover.
Write them in the same language as the question.
Return ONLY a raw JSON array of 3 strings, no markdown, no explanation.`,
      messages: [{
        role: 'user',
        content: `Question: ${question.slice(0, RELATED_INPUT_CHARS)}\n\nAnswer: ${answer.slice(0, RELATED_INPUT_CHARS)}`,
      }],
      maxOutputTokens: 160,
      abortSignal: AbortSignal.timeout(10000),
    })
    const match = raw.match(/\[[\s\S]*\]/)
    if (match) {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) {
        return c.json(parsed.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 3))
      }
    }
  } catch (e) {
    console.error('[related]', e instanceof Error ? e.message : e)
  }
  return c.json([])
})

/** Reattaches to a generation whose connection dropped, replaying everything after the last
 *  event the client saw and then following along live. Returns 404 once the run has expired,
 *  which the client treats as "give up" rather than an error. */
chatRouter.get('/resume/:sessionId', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('sessionId')
  const run = getRun(sessionId)
  if (!run || run.userId !== userId) return c.json({ error: 'No resumable run' }, 404)

  cancelAbandon(run)
  let index = Math.max(0, parseInt(c.req.query('from') ?? '0', 10) || 0)
  console.log(`  [stream] client resumed session ${sessionId} from event ${index}/${run.events.length}`)

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    await flushPreamble(stream)
    c.req.raw.signal.addEventListener('abort', () => scheduleAbandon(run))
    while (true) {
      while (index < run.events.length) {
        await stream.writeSSE({ data: run.events[index], id: String(index + 1) })
        index++
        // A replayed approval prompt carries the timeout it was created with, but the server's
        // clock has been running the whole time. Correct the countdown for any still parked;
        // ones already settled replay their approval_closed event and need nothing.
        const pending = JSON.parse(run.events[index - 1]) as { type?: string; id?: string }
        if (pending.type === 'approval' && pending.id) {
          const left = approvalTimeLeft(run, pending.id)
          if (left !== null) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'approval_time', id: pending.id, timeoutMs: left }) })
          }
        }
      }
      if (run.done) break
      // Returns early on a new event; the timeout doubles as the keepalive tick.
      await waitForEvents(run, index, KEEPALIVE_INTERVAL_MS)
      if (index >= run.events.length && !run.done) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) })
      }
    }
  })
})

chatRouter.post('/:sessionId/stop', async (c) => {
  const stopped = stopRun(c.req.param('sessionId'), c.get('userId') as string)
  return c.json({ stopped })
})

/** The user's answer to an egress approval prompt. Ownership is checked the same way `stop` does
 *  it: the run is looked up by session and must belong to the caller, so one user cannot release
 *  another's parked request. */
chatRouter.post('/:sessionId/approve', zValidator('json', z.object({
  id: z.string(),
  allow: z.boolean(),
})), async (c) => {
  const { id, allow } = c.req.valid('json')
  const run = getRun(c.req.param('sessionId'))
  if (!run || run.userId !== (c.get('userId') as string)) return c.json({ settled: false }, 404)
  return c.json({ settled: settleApproval(run, id, allow) })
})

chatRouter.post('/', rateLimitByUser(chatLimiter, 'chat'), zValidator('json', chatSchema), async (c) => {
  const userId = c.get('userId') as string
  const { sessionId, spaceId, messages: msgs, focusMode, searchCategories, includeFileIds, includeMemoryIds, collectionIds, ephemeral, regenerate } = c.req.valid('json')
  const searchCategory = toSearxngCategories(searchCategories)
  const sid = sessionId ?? randomUUID()

  // Both ids come straight from the client: without these checks a known space id leaks
  // another user's memories into this answer, and a known session id appends to their chat.
  if (spaceId && !await ownsSpace(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  if (sessionId && await sessionOwnership(sessionId, userId) === 'other') return c.json({ error: 'Not found' }, 404)

  // Same reason, one id at a time; unlike the two above this filters rather than refusing, because
  // a collection deleted in another tab should let the turn proceed without it rather than fail it.
  // Sorted so the cache key does not depend on the order the client happened to send.
  const collections = (await ownedCollectionIds(collectionIds ?? [], userId)).sort()

  // Read from the database, never from the request body — a lock the client could assert would be
  // decorative. Resolved from the chat's own space when it has one, so an existing chat stays
  // locked even if the client forgets to send spaceId.
  const existingSpaceId = sessionId
    ? (await db.select({ spaceId: chatSessions.spaceId }).from(chatSessions)
        .where(eq(chatSessions.id, sessionId)).get())?.spaceId ?? null
    : null
  const locked = await isSpaceLocked(existingSpaceId ?? spaceId)
  if (locked && focusMode === 'image') {
    return c.json({ error: 'Image generation is unavailable in a locked space — it would send the prompt to the diffusion server.' }, 409)
  }
  if (locked) console.log(`  [space] locked — no web search, URL fetching or image generation`)

  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  const preview = (lastUser?.content ?? '').slice(0, 100).replace(/\n/g, ' ')
  console.log(`\n━━━ [${focusMode}] ${preview}`)

  // Settings are read once here rather than per branch: the cache key depends on the custom
  // prompt, so a personalised answer can never be served to a different user or context.
  const userRow = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get()
  const parsedSettings = parseSettings(userRow?.settings ?? '{}')
  const customPrompt = parsedSettings.customPrompt as string | undefined
  // Everything that changes the answer for the same question belongs here. `searchCategories`
  // picks which corpus is searched and `locked` removes web search entirely, so leaving either
  // out served the previous filter's answer to a question asked under a different one.
  const cacheScope = [
    userId, spaceId ?? '',
    [...(includeFileIds ?? [])].sort().join(','),
    [...(includeMemoryIds ?? [])].sort().join(','),
    collections.join(','),
    customPrompt ?? '',
    [...(searchCategories ?? [])].sort().join(','),
    locked ? 'locked' : '',
  ].join('|')

  // History is part of the key: without it, two unrelated conversations ending in the same
  // follow-up ("Is it officially shut down?") collide and the second gets the first's answer.
  const ck = cacheKey(lastUser?.content ?? '', focusMode, cacheScope, msgs.slice(0, -1))
  // A retry must not be served the answer it is retrying.
  const cached = regenerate ? null : getCached<CachedAnswer>(ck)

  // Generation is bound to the run, not to this HTTP request, so a dropped connection can be
  // resumed instead of losing a half-finished answer. See lib/stream-buffer.ts.
  const run = startRun(sid, userId)
  const abortSignal = run.controller.signal
  c.req.raw.signal.addEventListener('abort', () => scheduleAbandon(run))

  // A cache hit is a real turn, not a shortcut around one: it emits the same events and runs the
  // same tail as a generated answer, so the exchange is saved and its citations still resolve.
  if (cached) {
    const t0 = Date.now()
    return streamRun(c, run, async (out) => {
      await out.writeSSE({ data: JSON.stringify({ type: 'session', sessionId: sid }) })
      await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: cached.content }) })
      if (cached.sources.length) await out.writeSSE({ data: JSON.stringify({ type: 'sources', sources: cached.sources }) })
      if (cached.fileSources.length) await out.writeSSE({ data: JSON.stringify({ type: 'file_sources', sources: cached.fileSources }) })
      await finishTurn(out, { sid, userId, msgs, fullContent: cached.content, sources: cached.sources, fileSources: cached.fileSources, spaceId, regenerate, ephemeral, t0 })
    })
  }

  if (focusMode === 'flash') {
    const [memoryBudget, ragBudget] = await Promise.all([
      spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(1000),
      spaceId ? getAppSetting('space_rag_budget', '500').then(Number) : Promise.resolve(0),
    ])
    const userQuery = lastUser?.content ?? ''
    const effectiveRag = (parsedSettings.useSpaceRag !== false) ? ragBudget : 0
    const { block: flashScopedBlock, fileSources: flashFileSources } = spaceId ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, userQuery, includeFileIds, includeMemoryIds) : { block: '', fileSources: [] }
    // Collections are picked per request and apply with or without a space, so they get their own
    // budget rather than the space one — which is deliberately 0 for a chat that has no space.
    const flashCollections = await buildCollectionBlock(collections, userQuery, await collectionRagBudget(collections))
    const resolvedMemoryBlock = joinMemoryBlocks(
      await userMemoryBlockIfEnabled(userId, parsedSettings, userQuery),
      flashScopedBlock,
      flashCollections.block,
    )
    const t0 = Date.now()
    let fullContent = ''
    return streamRun(c, run, async (out) => {
      await out.writeSSE({ data: JSON.stringify({ type: 'session', sessionId: sid }) })
      // Plain status rather than a log step: flash has exactly one phase, so a log of it would
      // be a list of length one. The client pairs this with a ticking timer.
      await out.writeSSE({ data: JSON.stringify({ type: 'status', text: 'Thinking…' }) })
      // Collection excerpts carry [C1] labels of their own, so their sources ride along or the
      // citations in the answer resolve to nothing.
      const flashSources = [...flashFileSources, ...flashCollections.fileSources]
      if (flashSources.length > 0) await out.writeSSE({ data: JSON.stringify({ type: 'file_sources', sources: flashSources }) })
      const flashSystem = FLASH_SYSTEM
        + (customPrompt ? `\n\nAdditional instructions:\n${customPrompt}` : '')
        + (resolvedMemoryBlock ? '\n\n' + resolvedMemoryBlock : '')
      const ctxLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
      const result = streamText({
        model: getFlashModel(),
        abortSignal,
        system: flashSystem,
        messages: trimMessages(msgs, Math.floor(ctxLimit * CONTEXT_RESERVE_FRACTION), flashSystem),
        maxOutputTokens: FLASH_MAX_TOKENS,
      })
      // Flash runs getFlashModel(), which is the full chat model unless FLASH_MODEL=small — the
      // same reasoning-capable model whose <think> output the other modes strip. Flash has no
      // thinking channel, so the extracted thinking is discarded rather than shown.
      const flashExtractor = new ThinkExtractor()
      const emitFlash = async (text: string) => {
        if (!text) return
        fullContent += text
        await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: text }) })
      }
      for await (const part of result.stream) {
        if (part.type === 'text-delta') await emitFlash(flashExtractor.process(part.text).text)
      }
      await emitFlash(flashExtractor.flush().text)
      console.log(`  [flash] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)
      if (fullContent.length >= 50) setCached(ck, { content: fullContent, sources: [], fileSources: flashSources })
      await finishTurn(out, { sid, userId, msgs, fullContent, sources: [], fileSources: flashSources, spaceId, regenerate, ephemeral, t0 })
    })
  }

  if (focusMode === 'image') {
    const imageBaseUrl = process.env.IMAGE_BASE_URL?.trim() || undefined
    if (!imageBaseUrl) {
      const t0 = Date.now()
      const notConfigured = 'Image generation is not configured. Set the IMAGE_BASE_URL environment variable to enable it.'
      return streamRun(c, run, async (out) => {
        await out.writeSSE({ data: JSON.stringify({ type: 'session', sessionId: sid }) })
        await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: notConfigured }) })
        // Through the shared tail like every other mode: calling persistMessage directly ignored
        // `ephemeral`, so a request that asked never to be stored wrote a session, a user message
        // and an empty assistant message anyway — and skipped the rest of the contract besides.
        await finishTurn(out, { sid, userId, msgs, fullContent: notConfigured, sources: [], fileSources: [], spaceId, regenerate, ephemeral, t0 })
      })
    }
    let pendingImageUrl: string | undefined
    const IMAGE_MD_RE = /!\[.*?\]\((\/images\/[\w-]+\/[\w-]+\.png)\)/g
    let lastGeneratedImageUrl: string | undefined
    for (const m of msgs) {
      for (const [, url] of (m.content as string).matchAll(IMAGE_MD_RE)) lastGeneratedImageUrl = url
    }
    // Image's search runs through the same plumbing as the other modes: blocked engines reach the
    // user instead of vanishing, and the paid-fallback cap covers this path too. Errors are
    // buffered rather than emitted directly — the tool closure is built before the SSE stream is.
    const imageApiBudget: SearchApiBudget = { remaining: parseInt(process.env.SEARCH_API_MAX_PER_REQUEST ?? '3', 10) }
    const imageEngineErrors = new Map<string, EngineError>()
    const warnImageEngineErrors = (errors: EngineError[]) => errors.forEach(e => imageEngineErrors.set(e.engine, e))
    // Same buffering as the engine errors, and for the same reason. Without these the client
    // saw zero sources whether or not image searched, so a blocked engine that the keyed
    // fallback covered still read as "answered without web results".
    const imageSources: SearchResult[] = []
    const pendingImageSources: SearchResult[] = []
    // Shared by the tool schema and the leaked-call recovery below, which validates a call the
    // model wrote as text against the same shape before running it.
    const generateImageSchema = z.object({
      prompt: z.string().describe('Detailed visual description for image generation'),
      size: z.string().optional().describe('Image dimensions e.g. "512x512", "1024x1024", "1024x576"'),
      negative_prompt: z.string().optional().describe('What to keep out of the image, comma-separated (e.g. "blurry, text, watermark"). Put anything the user says to avoid here rather than in prompt'),
      quality: z.enum(['draft', 'balanced', 'high']).optional().describe('Quality tier taken from the user\'s wording. Resolved to a step count by the server; prefer this over steps'),
      steps: z.number().int().optional().describe('Explicit step count. Only when the user names a number outright; otherwise leave unset and use quality'),
      seed: z.number().int().optional().describe('Random seed. Only set when the user explicitly asks for a specific seed or to reproduce an earlier image; omit otherwise so the result varies'),
    })
    const editImageSchema = z.object({
      image_url: z.string().describe('The /images/... URL of the image to edit (from chat history)'),
      prompt: z.string().describe('Full description of the desired result, including unchanged aspects'),
      strength: z.number().min(0).max(1).optional()
        .describe('How much of the image to redraw. 0.3-0.45 to alter or remove a small object; 0.5-0.65 to recolour the main subject, or to change style or lighting; 0.8+ to reimagine it. Colour survives a low-strength pass — the original hue bleeds through — so recolouring needs more than its size suggests. Always set this: the 0.75 default redraws most of the picture.'),
      size: z.string().optional().describe('Output dimensions e.g. "512x512". Defaults to source size.'),
      negative_prompt: z.string().optional().describe('What to keep out of the image, comma-separated (e.g. "blurry, text, watermark"). Put anything the user says to avoid here rather than in prompt'),
      quality: z.enum(['draft', 'balanced', 'high']).optional().describe('Quality tier taken from the user\'s wording. Resolved to a step count by the server; prefer this over steps'),
      steps: z.number().int().optional().describe('Explicit step count. Only when the user names a number outright; otherwise leave unset and use quality'),
      seed: z.number().int().optional().describe('Random seed. Only set when the user explicitly asks for a specific seed or to reproduce an earlier image; omit otherwise so the result varies'),
    })

    const runGenerateImage = async ({ prompt, size, negative_prompt, quality, steps, seed }: z.infer<typeof generateImageSchema>) => {
      const usedSeed = seed ?? randomSeed()
      const usedSteps = resolveSteps(quality, steps)
      const origin = quality ?? (steps ? 'explicit' : 'default')
      console.log(`  [image] → ${imageBaseUrl} (${IMAGE_API})  prompt="${prompt}"  negative="${negative_prompt ?? ''}"  size=${size ?? 'default'}  steps=${usedSteps} (${origin})  seed=${usedSeed}${seed === undefined ? ' (random)' : ''}`)
      try {
        const bytes = await imageBackend(imageBaseUrl).generate({ prompt, size, negativePrompt: negative_prompt, steps: usedSteps, seed: usedSeed })
        pendingImageUrl = await saveGeneratedImage(userId, bytes)
        lastGeneratedImageUrl = pendingImageUrl
        rememberRender(pendingImageUrl, { negativePrompt: negative_prompt, steps: usedSteps, seed: usedSeed })
        return { success: true, prompt, seed: usedSeed }
      } catch (e) {
        console.error(`  [image] error:`, e)
        return { success: false, error: e instanceof Error ? e.message : String(e), prompt }
      }
    }

    const runEditImage = async ({ image_url, prompt, strength, size, negative_prompt, quality, steps, seed }: z.infer<typeof editImageSchema>) => {
      const imagePath = imageFilePath(userId, image_url)
      if (!imagePath) {
        return { success: false, error: 'Invalid image reference', prompt }
      }
      // Explicit wording in this turn wins; otherwise inherit from the image being edited.
      const source = renderByImage.get(image_url)
      const askedForQuality = quality !== undefined || steps !== undefined
      const usedSteps = askedForQuality ? resolveSteps(quality, steps) : source?.steps ?? resolveSteps(undefined, undefined)
      // Inheriting the seed makes an identical request reproduce the identical image, so a
      // retry has to break out of it — that is the one case where the user wants a new attempt.
      const inheritSeed = !regenerate ? source?.seed : undefined
      const usedSeed = seed ?? inheritSeed ?? randomSeed()
      const usedNegative = negative_prompt ?? source?.negativePrompt
      const stepOrigin = askedForQuality ? (quality ?? 'explicit') : source ? 'inherited' : 'default'
      const seedOrigin = seed !== undefined ? '' : inheritSeed !== undefined ? ' (inherited)' : regenerate ? ' (retry)' : ' (random)'
      // Steps are scaled by 1/strength inside the backend, so report what is actually sent —
      // the tier alone reads like the compensation never happened.
      const sentSteps = IMAGE_API === 'sdapi' ? compensateSteps(usedSteps, strength ?? DEFAULT_EDIT_STRENGTH) : usedSteps
      console.log(`  [image] edit → ${imageBaseUrl} (${IMAGE_API})  prompt="${prompt}"  negative="${usedNegative ?? ''}"${negative_prompt === undefined && usedNegative ? ' (carried)' : ''}  strength=${strength ?? DEFAULT_EDIT_STRENGTH}${strength === undefined ? ' (default)' : ''}  steps=${usedSteps} (${stepOrigin}) → ${sentSteps} sent  seed=${usedSeed}${seedOrigin}`)
      try {
        const image = await readFile(imagePath)
        const bytes = await imageBackend(imageBaseUrl).edit({ image, prompt, strength, size, negativePrompt: usedNegative, steps: usedSteps, seed: usedSeed })
        pendingImageUrl = await saveGeneratedImage(userId, bytes)
        lastGeneratedImageUrl = pendingImageUrl
        rememberRender(pendingImageUrl, { negativePrompt: usedNegative, steps: usedSteps, seed: usedSeed })
        return { success: true, prompt, seed: usedSeed }
      } catch (e) {
        console.error(`  [image] edit error:`, e)
        return { success: false, error: e instanceof Error ? e.message : String(e), prompt }
      }
    }

    const imageTools = {
      web_search: tool({
        description: 'Search the web for context about a specialized or unfamiliar subject before generating an image.',
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) => {
          console.log(`  [image] web_search "${query}"`)
          const results = await webSearch(query, 10, undefined, warnImageEngineErrors, imageApiBudget)
          const seen = new Set(imageSources.map(s => s.url))
          for (const r of results) {
            if (seen.has(r.url)) continue
            seen.add(r.url)
            imageSources.push(r)
            pendingImageSources.push(r)
          }
          return results.map(r => `${r.title}: ${r.content}`).join('\n\n')
        },
      }),
      generate_image: tool({
        description: 'Generate an image from a text description using a local diffusion model.',
        inputSchema: generateImageSchema,
        execute: runGenerateImage,
      }),
      edit_image: tool({
        description: 'Modify a previously generated image. Use when the user asks to change, edit, or iterate on an image.',
        inputSchema: editImageSchema,
        execute: runEditImage,
      }),
    }
    const imageSystem = `You are an image generation assistant.
- When asked to draw, illustrate, create, or generate an image, call generate_image with a detailed visual prompt.
- When asked to edit, change, or modify a previously generated image, call edit_image.${lastGeneratedImageUrl ? ` The most recently generated image is at ${lastGeneratedImageUrl}.` : ''}
- If the subject is specialized, technical, or you are uncertain what it looks like visually, call web_search first to gather context, then use what you learned to write a richer prompt.
- Extract size from resolution strings, and set quality to draft, balanced or high from wording like "quick sketch", "high quality" or "detailed". Do not convert quality into a step count yourself — pass the word and let the server decide. Use steps only if the user names a number outright.
- Put every exclusion in negative_prompt, never in prompt — both what the user asked to avoid and any boilerplate you would add yourself ("no text", "no watermark", "not blurry"). A diffusion model cannot represent negation inside a prompt, so "no text" there tends to produce text. prompt describes only what should be present.
- On edit_image, choose strength from how much the user asked to change: altering or removing a small object is 0.3-0.45, recolouring the main subject or changing style or lighting is 0.5-0.65, a full reimagining is 0.8+. Recolouring needs a mid strength even though it sounds small — at 0.35 the original colour bleeds through and you get a half-changed result. Leaving it unset redraws most of the image.
- Pass seed only when the user names one, or asks to reuse or reproduce a previous image's seed. Never invent one: omitting it makes each render vary.
- If you used web_search, respond with one sentence summarizing what you learned that shaped the prompt. Otherwise output nothing — do not add any text, URLs, or commentary after the image tool call.
- Always respond in the same language the user used.`
    const t0 = Date.now()
    let fullContent = ''
    return streamRun(c, run, async (out) => {
      await out.writeSSE({ data: JSON.stringify({ type: 'session', sessionId: sid }) })
      const ctxLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
      // Not the flash model: this drives a multi-step tool loop with five typed parameters, and
      // with FLASH_MODEL=small that is a small model doing the least reliable thing asked of it —
      // a misparsed size/steps degrades the image with no visible error.
      const result = streamText({
        model: getChatModel(),
        abortSignal,
        system: imageSystem,
        messages: trimMessages(msgs, Math.floor(ctxLimit * CONTEXT_RESERVE_FRACTION), imageSystem),
        tools: imageTools,
        stopWhen: stepCountIs(4),
        maxOutputTokens: RESEARCH_MAX_TOKENS,
      })
      // Diffusion emits nothing until the image is finished, so this stream can go minutes
      // without a byte — far longer than the other modes, which are at worst waiting on a
      // search. Without the ping an idle-timeout upstream reaps the connection mid-generation.
      const keepalive = setInterval(() => { out.ping().catch(() => {}) }, KEEPALIVE_INTERVAL_MS)
      // Image mode's text is buffered rather than streamed delta-by-delta: diffusion blocks the
      // stream for minutes anyway, and the system prompt permits at most one summary sentence — so
      // nothing is lost by holding it, and holding it lets a tool call the model wrote as text
      // (see the recovery below) be scrubbed before the user ever sees it.
      let rawText = ''
      let sawImageTool = false
      const emittedImages: Array<{ url: string; alt: string }> = []
      const emitImage = async (url: string, alt: string) => {
        emittedImages.push({ url, alt })
        await out.writeSSE({ data: JSON.stringify({ type: 'image', url, alt }) })
      }
      try {
        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            rawText += part.text
          } else if (part.type === 'tool-call') {
            if (part.toolName === 'web_search') {
              const q = (part.input as { query?: string } | undefined)?.query
              await out.writeSSE({ data: stepEvent({ kind: 'search', queries: q ? [q] : [] }) })
            } else if (part.toolName === 'generate_image') {
              sawImageTool = true
              await out.writeSSE({ data: stepEvent({ kind: 'image' }) })
            } else if (part.toolName === 'edit_image') {
              sawImageTool = true
              await out.writeSSE({ data: stepEvent({ kind: 'image', detail: 'Editing image…', detailKey: 'log.imageEdit' }) })
            }
          } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
            if (pendingImageSources.length) {
              await out.writeSSE({ data: stepEvent({ kind: 'results', count: pendingImageSources.length }) })
              await out.writeSSE({ data: JSON.stringify({ type: 'sources', sources: pendingImageSources.splice(0) }) })
            }
            if (imageEngineErrors.size) {
              const engines = [...imageEngineErrors.values()].map(e => ({ engine: e.engine, reason: e.reason }))
              imageEngineErrors.clear()
              await out.writeSSE({ data: JSON.stringify({ type: 'search_warning', engines }) })
            }
          } else if (part.type === 'tool-result' && (part.toolName === 'generate_image' || part.toolName === 'edit_image')) {
            const r = part.output as { success?: boolean; prompt?: string; error?: string }
            if (r.success && pendingImageUrl) {
              await emitImage(pendingImageUrl, r.prompt ?? '')
              pendingImageUrl = undefined
            }
          }
        }

        // gemma-4 behind LiteLLM intermittently answers image mode by writing the tool call into
        // its text as a LangChain ReAct-JSON blob — `{ "action": "generate_image", "action_input":
        // "{'prompt': ...}" }` — rather than emitting a real call. The AI SDK never parses that, so
        // without this the blob is the whole reply and no image is produced. Recover the call from
        // the text, validate it against the real schema, and run it.
        const leak = findLeakedToolCall(rawText, ['generate_image', 'edit_image'], 'generate_image')
        if (leak && !sawImageTool && emittedImages.length === 0) {
          const args = coerceNumericArgs(leak.input, ['steps', 'seed', 'strength'])
          if (leak.action === 'edit_image') {
            const parsed = editImageSchema.safeParse(args)
            if (parsed.success) {
              await out.writeSSE({ data: stepEvent({ kind: 'image', detail: 'Editing image…', detailKey: 'log.imageEdit' }) })
              const r = await runEditImage(parsed.data)
              if (r.success && pendingImageUrl) { await emitImage(pendingImageUrl, r.prompt ?? ''); pendingImageUrl = undefined }
              else console.warn(`  [image] recovered edit_image call failed: ${'error' in r ? r.error : 'no image'}`)
            } else {
              console.warn(`  [image] recovered edit_image args rejected: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`)
            }
          } else {
            const parsed = generateImageSchema.safeParse(args)
            if (parsed.success) {
              await out.writeSSE({ data: stepEvent({ kind: 'image' }) })
              const r = await runGenerateImage(parsed.data)
              if (r.success && pendingImageUrl) { await emitImage(pendingImageUrl, r.prompt ?? ''); pendingImageUrl = undefined }
              else console.warn(`  [image] recovered generate_image call failed: ${'error' in r ? r.error : 'no image'}`)
            } else {
              console.warn(`  [image] recovered generate_image args rejected: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`)
            }
          }
        }

        // Drop <think>/<tool_call> markup and the leaked blob, then send what remains — normally a
        // single sentence, or nothing — as the visible reply in one write.
        const thinkExtractor = new ThinkExtractor()
        let visible = thinkExtractor.process(rawText).text + thinkExtractor.flush().text
        visible = stripLeakedToolCall(visible, leak?.source)
        if (visible) await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: visible }) })
        fullContent = visible
        for (const img of emittedImages) {
          fullContent += `${fullContent ? '\n\n' : ''}![${img.alt}](${img.url})`
        }
      } finally {
        clearInterval(keepalive)
      }
      console.log(`  [image] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)
      await finishTurn(out, { sid, userId, msgs, fullContent, sources: imageSources, fileSources: [], spaceId, regenerate, ephemeral, t0 })
    })
  }

  // Strip injected attachment content (everything after \n\n---\n) before reformulating,
  // so the small model only sees the actual query and doesn't overflow its context.
  const msgsForReformulate = msgs.map(m =>
    m.role === 'user'
      ? { ...m, content: m.content.replace(/\n\n---\n[\s\S]*$/, '').trim() }
      : m
  )

  const hasAttachment = /\n\n---\n\[/.test(lastUser?.content ?? '')

  const t0 = Date.now()

  return streamRun(c, run, async (out) => {
    // The stream opens before any of the preparation below. Reformulation, pre-search, memory
    // building and URL prefetching together cost ~2s, and until this point the client held an
    // open request with nothing on it — indistinguishable from a server that has stopped
    // responding. Everything here is awaited inside the handler so the wait is narrated.
    await out.writeSSE({ data: JSON.stringify({ type: 'session', sessionId: sid }) })

    // Plain status = the transient one-liner (errors). emitStep = an entry in the activity log.
    const emitStatus = (text: string) =>
      out.writeSSE({ data: JSON.stringify({ type: 'status', text }) })
    const emitStep = (step: ProgressStep) => out.writeSSE({ data: stepEvent(step) })
    await emitStep({ kind: 'understand' })

    /** Ask the user whether an outbound request the egress guard flagged may be sent.
     *
     *  The generation parks here until they answer. The keepalive pings already running around
     *  each researcher stream hold the connection open meanwhile, and every way out of the wait
     *  other than an explicit Allow resolves to false. */
    const requestApproval = async (req: EgressApprovalRequest): Promise<boolean> => {
      const id = randomUUID()
      await out.writeSSE({ data: JSON.stringify({
        type: 'approval', id, kind: req.kind, target: req.target,
        reasons: req.reasons, timeoutMs: APPROVAL_TIMEOUT_MS,
      }) })
      const allowed = await awaitApproval(run, id)
      console.log(`  [egress] ${req.kind} ${allowed ? 'allowed' : 'refused'} by user — ${req.target.slice(0, 120)}`)
      await out.writeSSE({ data: JSON.stringify({ type: 'approval_closed', id, allowed }) })
      return allowed
    }

    const [fetchMaxPages, urlContextChars, fetchSummarize, compressHistory] = await Promise.all([
      getAppSetting('fetch_max_pages', '8').then(Number),
      getAppSetting('fetch_max_url_context_chars', String(DEFAULT_MAX_URL_CONTEXT_CHARS)).then(Number),
      getAppSetting('fetch_summarize_overflow', 'false').then(v => v === 'true'),
      getAppSetting('compress_history_overflow', 'false').then(v => v === 'true'),
    ])

    // Shared per-request allowance for paid keyed-API fallback searches (pre-search + researcher).
    const apiBudget: SearchApiBudget = { remaining: parseInt(process.env.SEARCH_API_MAX_PER_REQUEST ?? '3', 10) }

    // Fetch user settings + file count + reformulate/pre-search + memory + URL prefetch in parallel.
    // In a locked space the two network legs are skipped outright rather than filtered later: the
    // pre-search runs before the model is involved, and URL prefetching would fetch a link pasted
    // beside the document without any tool being called at all.
    const [fileCountRow, { initialQueries, initialResults, engineErrors }, memoryBudget, ragBudget, prefetchedUrls] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(uploadedFiles).where(eq(uploadedFiles.userId, userId)).get(),
      locked
        ? Promise.resolve({ initialQueries: [] as string[], initialResults: [] as SearchResult[], engineErrors: [] as EngineError[] })
        : runReformulateAndPreSearch(msgsForReformulate, focusMode as 'balanced' | 'thorough', hasAttachment, searchCategory, apiBudget, abortSignal),
      spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(1000),
      getAppSetting('space_rag_budget', '500').then(Number),
      locked ? Promise.resolve([]) : prefetchUrlsFromMessage(lastUser?.content ?? '', hasAttachment, fetchMaxPages),
    ])
    const userQuery = lastUser?.content ?? ''
    const hasFiles = (fileCountRow?.count ?? 0) > 0
    const effectiveRag = (parsedSettings.useSpaceRag !== false) ? ragBudget : 0
    const { block: scopedBlock, fileSources } = spaceId
      ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, userQuery, includeFileIds, includeMemoryIds)
      : (hasFiles && parsedSettings.useChatRag !== false)
        ? await buildChatFileBlock(userId, userQuery, ragBudget)
        : { block: '', fileSources: [] }
    const collectionBlock = await buildCollectionBlock(collections, userQuery, await collectionRagBudget(collections))
    // User memory applies to every chat, including those with no space at all.
    const memoryBlock = joinMemoryBlocks(
      await userMemoryBlockIfEnabled(userId, parsedSettings, userQuery),
      scopedBlock,
      collectionBlock.block,
    )
    const showThinkingSettings = (parsedSettings.showThinking ?? { balanced: false, thorough: false }) as { balanced: boolean; thorough: boolean }
    const showThinking = focusMode === 'balanced' ? showThinkingSettings.balanced
                       : focusMode === 'thorough'  ? showThinkingSettings.thorough
                       : false
    const useThinking: boolean = !!(parsedSettings.useThinking) && focusMode === 'thorough'

    const ctxTokenLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
    const estSystemChars = 500 + (memoryBlock?.length ?? 0) + (customPrompt?.length ?? 0)
    const estMsgsChars = msgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
    const urlBudgetChars = Math.max(0, contextCharBudget(ctxTokenLimit) - estSystemChars - estMsgsChars)
    const processedUrls = prefetchedUrls.length > 0
      ? await processUrlsForContext(prefetchedUrls, urlBudgetChars, fetchSummarize, urlContextChars)
      : prefetchedUrls

    let fullContent = ''
    const sources: unknown[] = []

    const allFileSources = [...fileSources, ...collectionBlock.fileSources]
    if (allFileSources.length > 0) await out.writeSSE({ data: JSON.stringify({ type: 'file_sources', sources: allFileSources }) })

    // Warn when a search came back empty *because* engines were blocked/suspended
    // (rate-limit, CAPTCHA, access denied) — distinct from a query that simply matched
    // nothing. Dedup by engine so the researcher's repeated searches don't spam the UI.
    // Emitted as a persistent 'search_warning' (NOT the ephemeral status line, which is
    // overwritten by later "Searching:" updates and cleared once answer text streams);
    // the client folds it into the final footer so the user sees *why* results are missing.
    const warnedEngines = new Set<string>()
    const warnEngineErrors = async (errors: EngineError[]) => {
      const fresh = errors.filter(e => !warnedEngines.has(e.engine))
      if (!fresh.length) return
      fresh.forEach(e => warnedEngines.add(e.engine))
      await out.writeSSE({ data: JSON.stringify({ type: 'search_warning', engines: fresh.map(e => ({ engine: e.engine, reason: e.reason })) }) })
    }
    if (!initialResults?.length && engineErrors?.length) await warnEngineErrors(engineErrors)

    /** Second line for one fetch_url, and only when the page did not fit as-is: the first was
     *  emitted at tool-call time so the log moves while the fetch runs. */
    const emitUrlOutcome = (host: string, outcome: UrlOutcome) =>
      emitStep({ kind: 'read', hosts: [host], detail: describeOutcome(outcome) })

    const emitSearchStatus = (args: { queries?: string[]; query?: string }) => {
      const queries: string[] = args.queries ?? (args.query ? [args.query] : [])
      if (queries.length) emitStep({ kind: 'search', queries })
    }

    /** Pre-search runs before the stream opens, so its steps are reported after the fact —
     *  the log still needs them, or the first thing the user sees is the researcher's
     *  second-round query with no sign of where the initial results came from. */
    const emitPreSearchSteps = async () => {
      if (processedUrls.length) {
        const reduced = processedUrls.filter(f => f.outcome).map(f => describeOutcome(f.outcome!))
        await emitStep({
          kind: 'read',
          hosts: processedUrls.map(f => new URL(f.url).hostname),
          detail: reduced.length ? reduced.join('; ') : undefined,
        })
      }
      if (!initialQueries?.length) return
      await emitStep({ kind: 'search', queries: initialQueries })
      if (initialResults?.length) await emitStep({ kind: 'results', count: initialResults.length })
      if (showThinking) {
        await out.writeSSE({ data: JSON.stringify({ type: 'thinking',
          delta: `🔍 Searching: ${initialQueries.map(q => `"${q}"`).join(', ')}\n` }) })
      }
    }

    if (focusMode === 'thorough') {
      // Phase 1: Research (collect sources, no text to client)
      await emitPreSearchSteps()
      if (showThinking && initialResults?.length) {
        const snippets = initialResults.slice(0, 3)
          .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
          .join('\n')
        await out.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: snippets + '\n\n' }) })
      }
      const researchModel = useThinking ? getThinkingModelOrFallback() : getChatModel()
      const allSources: SearchResult[] = [...(initialResults ?? [])]
      // URLs the user pointed at or the model chose to read in full — kept out of the reranker's
      // prune below so a page that was explicitly fetched always reaches the writer.
      const fetchedUrls = new Set<string>()
      const researcherResult = await runResearcher({ messages: msgs, focusMode, userId, model: researchModel, abortSignal, initialQueries, initialResults, prefetchedUrls: processedUrls, customPrompt, hasFiles, spaceId, sessionId: sid, memoryBlock, userMemoryEnabled: parsedSettings.userMemory === true, fetchSummarize, urlContextChars, compressHistory, searchCategory, onEngineErrors: warnEngineErrors, onUrlRead: emitUrlOutcome, onSource: (s) => { allSources.push(s); fetchedUrls.add(s.url) }, apiBudget, requestApproval, locked })
      let researcherNotes = ''
      // Unconditional: the extractor also drops leaked tool-call markup, which has to be stripped
      // whether or not the user is shown thinking. Displaying thinking is gated separately.
      const thoroughExtractor = new ThinkExtractor()

      const keepalive = setInterval(() => {
        out.ping().catch(() => {})
      }, KEEPALIVE_INTERVAL_MS)
      try {
        await drainResearcherStream(researcherResult, {
          stream: out, showThinking, emitSearchStatus, maxSteps: maxStepsFor('thorough'),
          extractor: thoroughExtractor,
          emitTextAsThinking: true,
          onText: (text) => { researcherNotes += text },
          onSources: (results) => { allSources.push(...results) },
        })
        // Note: thorough mode runs a writer pass regardless of researcher output, so no extra fallback needed here.
      } finally {
        clearInterval(keepalive)
      }

      // Dedup by URL
      const seen = new Set<string>()
      const dedupedSources = allSources.filter(s => {
        if (seen.has(s.url)) return false
        seen.add(s.url)
        return true
      })

      // Prunes as well as orders: previously this passed the full length as topN, so the
      // configured rerank_top_n was bypassed and every source reached the writer. Fetched pages
      // skip the prune — they were read deliberately — and lead the list so their numbers are low.
      const fetchedSources = dedupedSources.filter(s => fetchedUrls.has(s.url))
      const rerankedSources = await rerankSearchResults(userQueryOf(msgs), dedupedSources.filter(s => !fetchedUrls.has(s.url)))
      const finalSources = [...fetchedSources, ...rerankedSources]

      sources.push(...finalSources.map(toStoredSource))
      await out.writeSSE({ data: JSON.stringify({ type: 'sources', sources: finalSources }) })

      // Phase 2: Writer pass
      await emitStep({ kind: 'write' })
      const writerResult = runWriter(finalSources, msgs, researcherNotes.slice(0, RESEARCHER_NOTES_CAP), abortSignal, { customPrompt, memoryBlock })
      const writerExtractor = new ThinkExtractor()
      const writerCitations = new CitationNormalizer()
      const emitAnswer = async (raw: string) => {
        const clean = writerCitations.process(raw)
        if (clean) {
          fullContent += clean
          await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: clean }) })
        }
      }
      for await (const part of writerResult.stream) {
        if (part.type === 'text-delta') {
          const { text, thinking } = writerExtractor.process(part.text)
          if (thinking && showThinking) await out.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: thinking }) })
          if (text) await emitAnswer(text)
        } else if (part.type === 'reasoning-delta' && showThinking) {
          await out.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: part.text }) })
        } else if (part.type === 'error') {
          console.error('  [writer] stream error:', part.error)
        }
      }
      const { text: wt, thinking: wth } = writerExtractor.flush()
      if (wth && showThinking) await out.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: wth }) })
      if (wt) await emitAnswer(wt)
      const writerTail = writerCitations.flush()
      if (writerTail) {
        fullContent += writerTail
        await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: writerTail }) })
      }
      if (!fullContent) {
        console.error('  [writer] produced 0 chars — model may be in a bad state')
        await emitStatus('Model returned empty response. Try again or restart the model server.')
      }
    } else {
      // Speed / balanced: stream researcher output directly
      await emitPreSearchSteps()
      if (initialResults?.length) {
        if (showThinking) {
          const snippets = initialResults.slice(0, 3)
            .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
            .join('\n')
          await out.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: snippets + '\n\n' }) })
        }
        sources.push(...initialResults.map(toStoredSource))
        await out.writeSSE({ data: JSON.stringify({ type: 'sources', sources: initialResults }) })
      }

      const fullSources: SearchResult[] = []
      // A fetched page arrives as its own numbered result (prefetched before the stream, or via the
      // fetch_url tool mid-stream); surface it to the client the moment it lands so the [N] the
      // model then writes has a source to resolve against.
      const emitFetchedSource = async (s: SearchResult & { index: number }) => {
        fullSources.push(s)
        sources.push(toStoredSource(s))
        await out.writeSSE({ data: JSON.stringify({ type: 'sources', sources: [s] }) })
      }
      const result = await runResearcher({ messages: msgs, focusMode, userId, model: getChatModel(), abortSignal, initialQueries, initialResults, prefetchedUrls: processedUrls, customPrompt, hasFiles, spaceId, sessionId: sid, memoryBlock, userMemoryEnabled: parsedSettings.userMemory === true, fetchSummarize, urlContextChars, compressHistory, searchCategory, onEngineErrors: warnEngineErrors, onUrlRead: emitUrlOutcome, onSource: emitFetchedSource, apiBudget, requestApproval, locked })
      const extractor = new ThinkExtractor()   // see thoroughExtractor above
      const citations = new CitationNormalizer()

      const keepalive = setInterval(() => {
        out.ping().catch(() => {})
      }, KEEPALIVE_INTERVAL_MS)
      let drainFinishReason: string | undefined
      try {
        drainFinishReason = await drainResearcherStream(result, {
          stream: out, showThinking, emitSearchStatus, maxSteps: maxStepsFor('balanced'),
          extractor,
          onText: async (text) => {
            const clean = citations.process(text)
            if (clean) {
              fullContent += clean
              await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: clean }) })
            }
          },
          onSources: async (results) => {
            fullSources.push(...results)
            sources.push(...results.map(toStoredSource))
            await out.writeSSE({ data: JSON.stringify({ type: 'sources', sources: results }) })
          },
        })
      } finally {
        clearInterval(keepalive)
      }
      const citationTail = citations.flush()
      if (citationTail) {
        fullContent += citationTail
        await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: citationTail }) })
      }

      // Fallback: synthesise an answer when the researcher ended without producing one.
      // Two ways that happens: finishReason=tool-calls (the model's last action was a tool call, so
      // any accumulated content is intermediate reasoning preamble, not a real response), or
      // finishReason=stop with nothing left after extraction — the withheld-tools final step wrote
      // its call out as <tool_call> prose, which ThinkExtractor drops. See think-extractor.ts.
      if (drainFinishReason === 'tool-calls' || !fullContent.trim()) {
        console.warn(`  [${focusMode}] no answer (finish=${drainFinishReason}, ${fullContent.length} chars) — running no-tool synthesis fallback`)
        fullContent = ''
        await emitStep({ kind: 'write', detail: 'Synthesising answer…', detailKey: 'log.synthesise' })
        const fallback = runSynthesisFallback({
          results: [...(initialResults ?? []), ...fullSources],
          messages: msgs,
          memoryBlock,
          abortSignal,
        })
        // Same extraction as the main pass: this call carries no tool schemas either, so a model
        // that emits <think> or <tool_call> markup would otherwise stream it as the answer.
        const fallbackExtractor = new ThinkExtractor()
        const fallbackCitations = new CitationNormalizer()
        const emitFallback = async ({ text, thinking }: { text: string; thinking: string }) => {
          if (thinking && showThinking) await out.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: thinking }) })
          const clean = text ? fallbackCitations.process(text) : ''
          if (clean) {
            fullContent += clean
            await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: clean }) })
          }
        }
        for await (const part of fallback.stream) {
          if (part.type === 'text-delta' && part.text) await emitFallback(fallbackExtractor.process(part.text))
        }
        await emitFallback(fallbackExtractor.flush())
        const fallbackTail = fallbackCitations.flush()
        if (fallbackTail) {
          fullContent += fallbackTail
          await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: fallbackTail }) })
        }
      }
    }

    // Last line of defence: nothing survived the main pass or the fallback. Name the failure in
    // the answer body — an empty `done` reads to the client as an unreachable server.
    const emptyAnswer = !fullContent.trim()
    if (emptyAnswer) {
      console.error(`  [${focusMode}] empty answer after fallback — reporting failure to the client`)
      fullContent = EMPTY_ANSWER_MESSAGE
      await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: fullContent }) })
    }

    if (fullContent.length < 50) console.log(`  [debug] short content: ${JSON.stringify(fullContent)}`)
    console.log(`  [${focusMode}] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)

    // Never cache the failure notice — it would be replayed as the answer for every repeat of
    // this question until the entry expires.
    if (!emptyAnswer && fullContent.length >= 50) setCached(ck, { content: fullContent, sources, fileSources: allFileSources })
    await finishTurn(out, { sid, userId, msgs, fullContent, sources, fileSources: allFileSources, spaceId, regenerate, ephemeral, t0 })
  })
})

/** What a cached answer has to carry. Content alone is not enough: the client resolves `[N]`
 *  positionally against the sources it was sent, so replaying text without them renders every
 *  citation dead. Same for `fileSources` and `[F1]`/`[C1]`. */
interface CachedAnswer {
  content: string
  sources: unknown[]
  fileSources: unknown[]
}

/** Common tail for every mode: persist the exchange, close the stream, and kick off the
 *  background memory/index work. Centralised because four branches ran their own copy and the
 *  cached-answer path quietly omitted all of it — losing the turn from the conversation. */
async function finishTurn(out: SSEStream, {
  sid, userId, msgs, fullContent, sources, fileSources, spaceId, regenerate, ephemeral, t0,
}: {
  sid: string
  userId: string
  msgs: Array<{ role: 'user' | 'assistant'; content: string }>
  fullContent: string
  sources: unknown[]
  fileSources: unknown[]
  spaceId?: string
  regenerate?: boolean
  ephemeral?: boolean
  t0: number
}): Promise<void> {
  const elapsedMs = Date.now() - t0
  if (ephemeral) {
    await out.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, elapsedMs }) })
    return
  }
  const { title, supersededAnswer } = await persistMessage(sid, userId, msgs, fullContent, sources, fileSources, spaceId, regenerate)
  await out.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title, elapsedMs }) })
  // Outside the spaceId block below: a regenerate strands its predecessor's image whether or not
  // the chat belongs to a space. Fire-and-forget, as the chat-delete path does — a failed unlink
  // costs a stray file the startup sweep will collect, and must not fail the turn.
  if (supersededAnswer) {
    deleteSupersededImages(supersededAnswer, fullContent).catch(e => console.error('[image] superseded cleanup failed:', e))
  }
  if (spaceId) {
    // Indexing is content-addressed and idempotent, so re-running it for the same question costs
    // nothing — but the answer that was just thrown away has to be removed explicitly.
    if (supersededAnswer) deindexContent(sid, supersededAnswer)
    const lastUserContent = userQueryOf(msgs)
    extractMemoriesPostHoc(spaceId, sid, lastUserContent, fullContent).catch(e => console.error('[memory]', e))
    indexContents(sid, [lastUserContent, fullContent].filter(Boolean)).catch(e => console.error('[chat-index]', e))
  }
}

/** 2 KB of SSE comment, written before any real event.
 *
 *  Status events are ~60 bytes. A proxy that buffers by byte count holds them until something
 *  fills its 4–8 KB buffer, which in practice is the answer text — by which time the client has
 *  already cleared the status line, so the whole progress narration is invisible and the answer
 *  arrives in bursts. This forces the first flush immediately.
 *
 *  Written raw rather than through `recordingStream`: the resume cursor counts recorded events
 *  and padding is not one, the same reason pings are excluded. A `:` comment line is ignored by
 *  the client parser, which reads only lines starting with `data: `. */
export const flushPreamble = (stream: SSEStreamingApi) =>
  stream.write(': ' + ' '.repeat(2048) + '\n\n')

/** Runs an SSE handler with every payload recorded for resume, marking the run finished
 *  however the handler exits so a reconnecting client isn't left waiting on a dead run.
 *
 *  `X-Accel-Buffering: no` disables nginx's response buffering for this response alone, so
 *  streaming works behind a reverse proxy whether or not `proxy_buffering off` is configured
 *  there. Hono's streamSSE does not set it; routes/users.ts sets the same pair. */
function streamRun(c: Context<AppEnv>, run: LiveRun, fn: (out: SSEStream) => Promise<void>) {
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    await flushPreamble(stream)
    try {
      await fn(recordingStream(stream, run))
    } finally {
      finishRun(run)
    }
  })
}

/** Wraps the live SSE stream so every payload is also recorded for resume, and so a dead
 *  connection stops the writes without stopping the generation — the whole point of the
 *  buffer is that work continues while nobody is listening. */
export function recordingStream(stream: SSEStreamingApi, run: LiveRun): SSEStream {
  return {
    writeSSE: async ({ data }) => {
      const id = appendEvent(run, data)
      try {
        await stream.writeSSE({ data, id: String(id) })
      } catch {
        // Client is gone; the payload is buffered and will be replayed on resume.
      }
    },
    ping: async () => {
      try {
        await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) })
      } catch {
        // Client is gone; nothing to buffer — the next real event carries the state.
      }
    },
  }
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)]
    .map(m => m[0].replace(/[.,;!?]+$/, ''))
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, 2)
}

async function prefetchUrlsFromMessage(text: string, hasAttachment: boolean, maxPages = 8): Promise<ProcessedUrl[]> {
  if (hasAttachment) return []
  const urls = extractUrls(text)
  if (!urls.length) return []
  console.log(`  [fetch-url] pre-fetching ${urls.length} URL(s): ${urls.join(', ')}`)
  return Promise.all(urls.map(async url => ({ url, content: await fetchUrlAllPages(url, maxPages) })))
}

function toSearxngCategories(cats?: string[]): string | undefined {
  if (!cats?.length) return undefined
  const map: Record<string, string> = { discussions: 'social media', tech: 'it' }
  return cats.map(c => map[c] ?? c).join(',')
}

async function runReformulateAndPreSearch(
  msgsForReformulate: Array<{ role: string; content: string }>,
  focusMode: 'balanced' | 'thorough',
  hasAttachment: boolean,
  categories?: string,
  apiBudget?: SearchApiBudget,
  abortSignal?: AbortSignal,
): Promise<{ initialQueries?: string[]; initialResults?: SearchResult[]; engineErrors?: EngineError[] }> {
  // Dedup engine errors by name across the (possibly multiple) pre-search queries.
  const errByEngine = new Map<string, EngineError>()
  const collect = (errors: EngineError[]) => errors.forEach(e => errByEngine.set(e.engine, e))
  const engineErrors = () => [...errByEngine.values()]
  try {
    if (hasAttachment) {
      console.log(`  [chat] attachment detected — skipping reformulation/pre-search`)
      return {}
    }
    const queryReformulation = await getAppSetting('query_reformulation', 'true').then(v => v === 'true')
    if (!queryReformulation) {
      const lastUser = [...msgsForReformulate].reverse().find(m => m.role === 'user')
      const q = lastUser?.content ?? ''
      if (!q) return {}
      console.log(`  [reformulate] disabled — using raw query: ${JSON.stringify(q.slice(0, 80))}`)
      const initialResults = await webSearch(q, 6, categories, collect, apiBudget)
      return { initialQueries: [q], initialResults, engineErrors: engineErrors() }
    }

    const countEach = focusMode === 'thorough' ? 10 : 6
    // reformulateLLM caps the list for the mode (and may add the raw query as a safety net), so
    // it is used as returned — slicing here again would drop that safety net.
    const queries = await reformulateLLM(msgsForReformulate, focusMode, abortSignal)
    if (queries.length === 0) return {}

    const found = await webSearchMulti(queries, countEach, categories, collect, apiBudget)
    return { initialQueries: queries, initialResults: await rerankSearchResults(userQueryOf(msgsForReformulate), found), engineErrors: engineErrors() }
  } catch (e) {
    console.error('[reformulate] error:', e)
    return {}
  }
}

async function persistMessage(
  sessionId: string,
  userId: string,
  msgs: Array<{ role: 'user' | 'assistant'; content: string }>,
  assistantContent: string,
  sources: unknown[],
  fileSources: unknown[],
  spaceId?: string,
  regenerate = false,
): Promise<{ title: string; supersededAnswer?: string }> {
  const now = new Date()
  const title = msgs.find(m => m.role === 'user')?.content.slice(0, SESSION_TITLE_MAX) ?? 'Chat'
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  let supersededAnswer: string | undefined

  await db.transaction(async (tx) => {
    await tx.insert(chatSessions).values({ id: sessionId, title, createdAt: now, updatedAt: now, userId, spaceId: spaceId ?? null })
      .onConflictDoUpdate({ target: chatSessions.id, set: { updatedAt: now, graduated: 1 } })
    if (regenerate) {
      // The question is already stored from the first attempt — replace only the answer, so a
      // retry doesn't leave the conversation with duplicate turns. Its text is returned so the
      // caller can drop its chunks too: deleting the message alone left the rejected answer
      // searchable through chat RAG.
      const previous = await tx.select({ id: messages.id, content: messages.content }).from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
        .orderBy(desc(messages.createdAt)).limit(1).get()
      if (previous) {
        supersededAnswer = previous.content
        await tx.delete(messages).where(eq(messages.id, previous.id))
      }
    } else if (lastUser) {
      await tx.insert(messages).values({ id: randomUUID(), sessionId, role: 'user', content: lastUser.content, createdAt: now })
    }
    await tx.insert(messages).values({ id: randomUUID(), sessionId, role: 'assistant', content: assistantContent, sources: JSON.stringify(sources), fileSources: JSON.stringify(fileSources), createdAt: now })
  })

  return { title, supersededAnswer }
}
