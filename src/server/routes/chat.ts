import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { generateText } from 'ai'
import type { EgressApprovalRequest } from '../lib/researcher.ts'
import type { SSEStream } from '../lib/researcher-stream.ts'
import { cacheKey, getCached, setCached } from '../lib/cache.ts'
import { db, chatSessions, messages, users, parseSettings } from '../lib/db.ts'
import { eq, and, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { hasTrustedSearch } from '../lib/search/index.ts'
import { getFlashModel } from '../lib/llm.ts'
import { resolveTurnModels, modelChoices, answerModelOf, attachAnswer, pickedModelOf, type ResolvedModels } from '../lib/cloud-models.ts'
import type { AnswerModel } from '../../shared/llm-catalogue.ts'
import { extractMemoriesPostHoc, toMemorySources } from '../lib/memory.ts'
import { ownedCollectionIds, ownedResourceIds } from '../lib/files/collections.ts'
import { readsConfidential, trackLeftOut, parseLockedBy } from '../lib/files/confidential.ts'
import { confidentialInScope } from '../lib/files/collection-coverage.ts'
import { hasAttachment, COLLECTION_MODES, type ContextReport } from '../../shared/context.ts'
import { MAX_EXAMPLES, MAX_INSTRUCTION_NOTES } from '../../shared/recipes.ts'
import { recipePrompt } from '../lib/recipes.ts'
import { contextCharBudget } from '../lib/trim-messages.ts'
import { indexContents, deindexContent } from '../lib/chat-indexer.ts'
import { ownsSpace, sessionOwnership } from '../lib/ownership.ts'
import { isSpaceLocked } from '../lib/space-lock.ts'
import { rateLimitByUser, chatLimiter, suggestLimiter } from '../lib/rate-limit.ts'
import {
  startRun, getRun, appendEvent, finishRun, waitForEvents,
  scheduleAbandon, cancelAbandon, stopRun, awaitApproval, settleApproval, approvalTimeLeft,
  APPROVAL_TIMEOUT_MS, type LiveRun,
} from '../lib/stream-buffer.ts'
import { deleteSupersededImages } from '../lib/image-store.ts'
import { linkNotesToAnswer } from '../lib/files/agent-notes.ts'
import { runTurn, createSink, toSearxngCategories, userQueryOf, documentSet, KEEPALIVE_INTERVAL_MS, type TurnContext } from '../lib/turn/index.ts'

const SESSION_TITLE_MAX = 60

// Content is generously bounded rather than tightly: a user message can carry an inlined
// attachment, capped separately by the attachment_chars setting (admin max 500000).
const chatSchema = z.object({
  sessionId: z.string().optional(),
  spaceId: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(600_000),
    /** Kept in full when history is trimmed — see trimMessages. */
    pinned: z.boolean().optional(),
  })).max(200),
  focusMode: z.enum(['flash', 'balanced', 'thorough', 'image']).default('balanced'),
  searchCategories: z.array(z.enum(['news', 'science', 'discussions', 'tech'])).optional(),
  includeFileIds: z.array(z.string()).optional(),
  includeMemoryIds: z.array(z.string()).optional(),
  /** Collections picked for this request only — they apply with or without a space. */
  collectionIds: z.array(z.string()).max(20).optional(),
  /** Resources read as Whole or Explore's documents, e.g. one document to save notes from. */
  documentIds: z.array(z.string()).max(20).optional(),
  ephemeral: z.boolean().optional(),
  /** Re-answering the last question: replaces the previous answer instead of appending. */
  regenerate: z.boolean().optional(),
  /** "Notes first": answer from the user's own notes (and the notes they link with) before the web. */
  notesFirst: z.boolean().optional(),
  /** A cloud catalogue model picked for this message only; refused picks fall back to local. */
  modelId: z.string().max(80).optional(),
  /** How the picked collections are read (shared/context.ts); auto when absent. */
  collectionMode: z.enum(COLLECTION_MODES).optional(),
  /** Explore may also search the web; ignored when the turn is locked. */
  exploreWeb: z.boolean().optional(),
  exploreNotes: z.boolean().optional(),
  /** Library resources whose text the client attached to the message, so a confidential one locks the turn. */
  attachedFileIds: z.array(z.string()).max(20).optional(),
  /** The recipe whose chip is in the chat input (lib/recipes.ts); its resources lock the turn like attachments. */
  recipe: z.object({
    name: z.string().min(1).max(100),
    instructionNoteIds: z.array(z.string()).max(MAX_INSTRUCTION_NOTES),
    exampleFileIds: z.array(z.string()).max(MAX_EXAMPLES),
  }).optional(),
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
      // The client aborts a suggestion that has gone stale; stopping here frees the model for the
      // request that replaced it rather than finishing an answer nobody will read.
      abortSignal: AbortSignal.any([AbortSignal.timeout(6000), c.req.raw.signal]),
    })
    const match = raw.match(/\[[\s\S]*\]/)
    if (match) {
      const suggestions = JSON.parse(match[0])
      if (Array.isArray(suggestions)) {
        return c.json(suggestions.slice(0, 4).filter((s): s is string => typeof s === 'string'))
      }
    }
  } catch (e) {
    if (c.req.raw.signal.aborted) return c.json([])
    // Autocomplete is optional; a timeout is routine and doesn't warrant a full stack dump.
    console.warn(`  [suggest] skipped: ${e instanceof Error ? e.message : e}`)
  }
  return c.json([])
})

const RELATED_INPUT_CHARS = 1500
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

/** The extra models this user may pick for a message now (none when picking is not enabled for
 *  them), and every model's context size for the meter. */
chatRouter.get('/models', async (c) => c.json(await modelChoices(c.get('userId') as string)))

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
  const { sessionId, spaceId, messages: requestMsgs, focusMode, searchCategories, includeFileIds, includeMemoryIds, collectionIds, ephemeral, regenerate, notesFirst, modelId, collectionMode = 'auto', attachedFileIds, exploreWeb, exploreNotes, recipe, documentIds: requestedDocumentIds } = c.req.valid('json')
  const sid = sessionId ?? randomUUID()
  const msgs = requestMsgs.map(({ role, content }) => ({ role, content }))

  // Both ids come straight from the client: without these checks a known space id leaks
  // another user's memories into this answer, and a known session id appends to their chat.
  if (spaceId && !await ownsSpace(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  if (sessionId && await sessionOwnership(sessionId, userId) === 'other') return c.json({ error: 'Not found' }, 404)

  // Same reason, one id at a time; unlike the two above this filters rather than refusing, because
  // a collection deleted in another tab should let the turn proceed without it rather than fail it.
  // Sorted so the cache key does not depend on the order the client happened to send.
  const collections = (await ownedCollectionIds(collectionIds ?? [], userId)).sort()
  const documentIds = (await ownedResourceIds(requestedDocumentIds ?? [], userId)).sort()

  const { locked, spaceLocked, lockedBy } = await turnLock(sessionId, spaceId, { collectionIds: collections, fileIds: [...includeFileIds ?? [], ...attachedFileIds ?? [], ...documentIds, ...recipe?.instructionNoteIds ?? [], ...recipe?.exampleFileIds ?? []] })
  if (locked && focusMode === 'image') {
    return c.json({ error: 'Image generation is unavailable in a locked chat — it would send the prompt to the diffusion server.' }, 409)
  }
  if (locked) console.log(`  [lock] locked turn — no ${await hasTrustedSearch() ? 'web search beyond trusted providers' : 'web search'}, URL fetching, image generation or cloud models`)
  // A locked turn in an unlocked space must not leave what it read in that space's memory or
  // history index, which the space's other, unlocked chats read.
  const spaceWrites = !locked || spaceLocked

  const lastUserContent = userQueryOf(msgs)
  console.log(`\n━━━ [${focusMode}] ${lastUserContent.slice(0, 100).replace(/\n/g, ' ')}`)

  // Settings are read once here rather than per branch: the cache key depends on the custom
  // prompt, so a personalised answer can never be served to a different user or context.
  const userRow = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get()
  const storedSettings = parseSettings(userRow?.settings ?? '{}')
  // Resolved once so every phase of this turn runs on the same models.
  const resolved = await resolveTurnModels({ userId, modelId, focusMode, locked, cloudAcknowledged: storedSettings.cloudAcknowledged === true })
  const settings = resolved.forceThinking ? { ...storedSettings, useThinking: true } : storedSettings
  const customPrompt = settings.customPrompt as string | undefined
  const recipeText = recipe ? recipePrompt(userId, recipe, contextCharBudget(resolved.models.chat.contextTokens)) : undefined
  // Everything that changes the answer for the same question belongs here. `searchCategories`
  // picks which corpus is searched and `locked` removes web search entirely, so leaving either
  // out served the previous filter's answer to a question asked under a different one.
  const cacheScope = [
    userId, spaceId ?? '',
    [...(includeFileIds ?? [])].sort().join(','),
    [...(includeMemoryIds ?? [])].sort().join(','),
    collections.join(','),
    documentIds.join(','),
    // Whole-collection and explored answers are never stored, but must not be served an excerpt answer either.
    collections.length || documentIds.length || (spaceId && (collectionMode === 'whole' || collectionMode === 'explore')) ? collectionMode : '',
    customPrompt ?? '',
    recipeText ? recipeText.instructions + recipeText.examples : '',
    [...(searchCategories ?? [])].sort().join(','),
    locked ? 'locked' : '',
    // The model that actually answers, so a cloud answer is never replayed for a local request.
    resolved.cloud?.id ?? '',
  ].join('|')

  // History is part of the key: without it, two unrelated conversations ending in the same
  // follow-up ("Is it officially shut down?") collide and the second gets the first's answer.
  const ck = cacheKey(lastUserContent, focusMode, cacheScope, msgs.slice(0, -1))
  // A retry must not be served the answer it is retrying.
  const cached = regenerate ? null : getCached<CachedAnswer>(ck)

  // Generation is bound to the run, not to this HTTP request, so a dropped connection can be
  // resumed instead of losing a half-finished answer. See lib/stream-buffer.ts.
  const run = startRun(sid, userId)
  c.req.raw.signal.addEventListener('abort', () => scheduleAbandon(run))
  // A turn locked by what it read, outside a locked space, locks its chat for good, naming why.
  const tail = { sid, userId, msgs, spaceId, regenerate, ephemeral, t0: Date.now(), lockedBy: locked && !spaceLocked ? lockedBy : undefined, spaceWrites }

  // A cache hit is a real turn, not a shortcut around one: it emits the same events and runs the
  // same tail as a generated answer, so the exchange is saved and its citations still resolve.
  // The cache key includes the model, so the cached text came from this same model too.
  if (cached) return streamRun(c, run, out => replayCached(out, cached, { ...tail, model: answerModelOf(resolved, focusMode) }, resolved))

  const ctx: TurnContext = {
    userId, sid, msgs, focusMode, spaceId, locked, spaceWrites, settings, customPrompt, recipe: recipeText, collections, documentIds, collectionMode, exploreWeb: exploreWeb === true && !locked, exploreNotes: exploreNotes === true,
    // Pins travel as indices, so the messages handed to the model carry nothing but role and content.
    pinned: new Set(requestMsgs.flatMap((m, i) => m.pinned ? [i] : [])),
    models: resolved.models,
    includeFileIds, includeMemoryIds, notesFirst, regenerate,
    searchCategory: toSearxngCategories(searchCategories),
    abortSignal: run.controller.signal,
  }
  return streamRun(c, run, async (out) => {
    const sink = createSink(out, approvalRequester(run, out))
    await sink.emit({ type: 'session', sessionId: sid })
    for (const event of modelEvents(resolved)) await sink.emit(event)
    // An unlocked turn leaves confidential resources out — of the picked collections, and of every
    // search it runs; the footer says how many.
    // Whole and Explore asked for in a space read the space's resources too (turn/context.ts documentSet).
    const readsDocuments = (!!spaceId || documentIds.length > 0) && (collectionMode === 'whole' || collectionMode === 'explore')
    const leftOut = new Set<string>(locked ? [] : confidentialInScope(readsDocuments ? documentSet(ctx) : collections))
    const result = await trackLeftOut(leftOut, () => runTurn(ctx, sink))
    if (leftOut.size) await sink.emit({ type: 'confidential_excluded', count: leftOut.size })
    const aborted = ctx.abortSignal.aborted
    // Without this a failing cloud model reads as an empty answer; the provider's own words say why.
    const error = resolved.observed.error
    const model = answerModelOf(resolved, focusMode, result.answeredBy)
    // Named by its provider for a pick, by the model itself for a default (local) one.
    if (error && !aborted) await sink.emit({ type: 'model_error', provider: resolved.provider?.label ?? model.label, message: error })
    if (result.cacheable && !aborted && result.content.length >= 50) {
      setCached(ck, { content: result.content, sources: result.sources, fileSources: result.fileSources })
    }
    // The latest report is also stored with the chat, so the meter reappears when it is reopened.
    // Read now, not before the turn: the hosting provider is known only once the calls report it.
    await finishTurn(out, { ...tail, fullContent: result.content, sources: result.sources, fileSources: result.fileSources, context: sink.lastContext, aborted, model, onStored: id => { attachAnswer(resolved, id); linkNotesToAnswer(userId, result.savedNoteIds ?? [], sid, id) } })
  })
})

/** Which model answers, or why the pick was refused; sent right after `session`. */
function modelEvents(resolved: ResolvedModels): Array<{ type: string; [k: string]: unknown }> {
  if (resolved.fallback) return [{ type: 'model_notice', ...resolved.fallback }]
  const model = pickedModelOf(resolved)
  return model ? [{ type: 'model', ...model }] : []
}

/** Whether this turn is locked: its space or chat is, or it reads a confidential collection or resource
 *  by name (lib/files/confidential.ts). Read from the database, never from a client-asserted flag — a lock
 *  the client could assert would be decorative. Resolved from the chat's own space when it has one,
 *  so an existing chat stays locked even if the client forgets to send spaceId. */
async function turnLock(
  sessionId: string | undefined,
  spaceId: string | undefined,
  reads: { collectionIds: string[]; fileIds: string[] },
): Promise<{ locked: boolean; spaceLocked: boolean; lockedBy: string[] }> {
  const session = sessionId
    ? await db.select({ spaceId: chatSessions.spaceId, locked: chatSessions.locked, lockedBy: chatSessions.lockedBy }).from(chatSessions)
        .where(eq(chatSessions.id, sessionId)).get()
    : undefined
  const spaceLocked = await isSpaceLocked(session?.spaceId ?? spaceId)
  const read = readsConfidential(reads)
  // What locked the chat before, and what this turn adds.
  const lockedBy = [...new Set([...parseLockedBy(session?.lockedBy), ...read])]
  return { locked: spaceLocked || !!session?.locked || read.length > 0, spaceLocked, lockedBy }
}

/** Emits a cached answer with the same events and tail as a generated one. */
async function replayCached(out: SSEStream, cached: CachedAnswer, tail: Omit<TurnTail, 'fullContent' | 'sources' | 'fileSources'>, resolved: ResolvedModels) {
  await out.writeSSE({ data: JSON.stringify({ type: 'session', sessionId: tail.sid }) })
  for (const event of modelEvents(resolved)) await out.writeSSE({ data: JSON.stringify(event) })
  await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: cached.content }) })
  if (cached.sources.length) await out.writeSSE({ data: JSON.stringify({ type: 'sources', sources: cached.sources }) })
  if (cached.fileSources.length) await out.writeSSE({ data: JSON.stringify({ type: 'file_sources', sources: cached.fileSources }) })
  await finishTurn(out, { ...tail, fullContent: cached.content, sources: cached.sources, fileSources: cached.fileSources })
}

/** Ask the user whether an outbound request the egress guard flagged may be sent.
 *
 *  The generation parks here until they answer. The keepalive pings already running around
 *  each researcher stream hold the connection open meanwhile, and every way out of the wait
 *  other than an explicit Allow resolves to false. */
const approvalRequester = (run: LiveRun, out: SSEStream) => async (req: EgressApprovalRequest): Promise<boolean> => {
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

/** What a cached answer has to carry. Content alone is not enough: the client resolves `[N]`
 *  positionally against the sources it was sent, so replaying text without them renders every
 *  citation dead. Same for `fileSources` and `[F1]`/`[C1]`. */
interface CachedAnswer {
  content: string
  sources: unknown[]
  fileSources: unknown[]
}

/** What the common tail needs to persist a turn. */
interface TurnTail {
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
  /** Absent for a cached answer, which leaves the stored report of the last real turn in place. */
  context?: ContextReport
  /** Stopped by the user. With nothing produced, the client withdraws the question, so the
   *  server must not store it either — it would reappear as a phantom turn on reload. */
  aborted?: boolean
  /** The model that answered. */
  model?: AnswerModel
  /** Called with the stored answer's id, e.g. so a late cost correction can reach it. */
  onStored?: (assistantMessageId: string) => void
  /** Set when the turn is locked outside a locked space: the chat is locked from now on, by these
   *  confidential collections and resources (empty when it was locked already). */
  lockedBy?: string[]
  /** False when the space's memory and history index must not take this turn (see `spaceWrites`). */
  spaceWrites?: boolean
}

/** Common tail for every mode: persist the exchange, close the stream, and kick off the
 *  background memory/index work. Centralised because four branches ran their own copy and the
 *  cached-answer path quietly omitted all of it — losing the turn from the conversation. */
async function finishTurn(out: SSEStream, {
  sid, userId, msgs, fullContent, sources, fileSources, spaceId, regenerate, ephemeral, t0, context, aborted, model, onStored, lockedBy, spaceWrites = true,
}: TurnTail): Promise<void> {
  const elapsedMs = Date.now() - t0
  if (ephemeral || (aborted && !fullContent.trim())) {
    await out.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, elapsedMs, ...(model && { model }) }) })
    return
  }
  const { title, supersededAnswer, userMessageId, assistantMessageId } = await persistMessage(sid, userId, msgs, fullContent, sources, fileSources, spaceId, regenerate, model)
  onStored?.(assistantMessageId)
  if (lockedBy) await db.update(chatSessions).set({ locked: true, lockedBy: JSON.stringify(lockedBy) }).where(eq(chatSessions.id, sid))
  if (context) await db.update(chatSessions).set({ contextReport: JSON.stringify(context) }).where(eq(chatSessions.id, sid))
  // The stored ids let the client pin these messages without reloading the chat.
  // The model again, now with the hosting provider the calls reported, for the live answer's badge.
  await out.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title, elapsedMs, userMessageId, assistantMessageId, ...(model && { model }), ...(lockedBy && { chatLocked: true, lockedBy }) }) })
  // Outside the spaceId block below: a regenerate strands its predecessor's image whether or not
  // the chat belongs to a space. Fire-and-forget, as the chat-delete path does — a failed unlink
  // costs a stray file the startup sweep will collect, and must not fail the turn.
  if (supersededAnswer) {
    deleteSupersededImages(supersededAnswer, fullContent).catch(e => console.error('[image] superseded cleanup failed:', e))
  }
  if (spaceId && spaceWrites) {
    // Indexing is content-addressed and idempotent, so re-running it for the same question costs
    // nothing — but the answer that was just thrown away has to be removed explicitly.
    if (supersededAnswer) deindexContent(sid, supersededAnswer)
    const lastUserContent = userQueryOf(msgs)
    // `sources` is this turn's reference list, ordered so index N-1 is the page cited as [N] — the
    // extractor maps a note's [N] markers straight onto it.
    extractMemoriesPostHoc(spaceId, sid, lastUserContent, fullContent, toMemorySources(sources))
      .catch(e => console.error('[memory]', e))
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

async function persistMessage(
  sessionId: string,
  userId: string,
  msgs: Array<{ role: 'user' | 'assistant'; content: string }>,
  assistantContent: string,
  sources: unknown[],
  fileSources: unknown[],
  spaceId?: string,
  regenerate = false,
  model?: AnswerModel,
): Promise<{ title: string; supersededAnswer?: string; userMessageId?: string; assistantMessageId: string }> {
  const now = new Date()
  const assistantMessageId = randomUUID()
  let userMessageId: string | undefined
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
      userMessageId = randomUUID()
      await tx.insert(messages).values({ id: userMessageId, sessionId, role: 'user', content: lastUser.content, pinned: hasAttachment(lastUser.content), createdAt: now })
    }
    await tx.insert(messages).values({ id: assistantMessageId, sessionId, role: 'assistant', content: assistantContent, sources: JSON.stringify(sources), fileSources: JSON.stringify(fileSources), model: model ? JSON.stringify(model) : null, createdAt: now })
  })

  return { title, supersededAnswer, userMessageId, assistantMessageId }
}
