import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { streamText, generateText, tool } from 'ai'
import { runResearcher } from '../lib/researcher.ts'
import { runWriter } from '../lib/writer.ts'
import { reformulateLLM } from '../lib/reformulate.ts'
import { cacheKey, getCached, setCached } from '../lib/cache.ts'
import { db, chatSessions, messages, users, uploadedFiles, parseSettings, getAppSetting } from '../lib/db.ts'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { webSearch, webSearchMulti, type SearchResult, type EngineError, type SearchApiBudget } from '../lib/searxng.ts'
import { fetchUrlAllPages, processUrlsForContext } from '../lib/fetch-url.ts'
import { getFlashModel, getChatModel, getThinkingModelOrFallback, RESEARCH_MAX_TOKENS } from '../lib/llm.ts'
import { ThinkExtractor } from '../lib/think-extractor.ts'
import { rerank, rerankEnabled } from '../lib/reranker.ts'
import { buildMemoryBlock, buildChatFileBlock, extractMemoriesPostHoc } from '../lib/memory.ts'
import { trimMessages, contextCharBudget, CONTEXT_RESERVE_FRACTION } from '../lib/trim-messages.ts'
import { indexContents } from '../lib/chat-indexer.ts'
import { ownsSpace, sessionOwnership } from '../lib/ownership.ts'
import { rateLimitByUser, chatLimiter, suggestLimiter } from '../lib/rate-limit.ts'
import { IMAGE_STORAGE_DIR, IMAGE_TIMEOUT_MS } from '../lib/image-store.ts'
// Memo of image directories already mkdir'd, to skip the syscall. One entry per user, so it
// only needs a sanity bound rather than real eviction.
const _createdImageDirs = new Set<string>()
const MAX_MEMOIZED_IMAGE_DIRS = 1000
function rememberImageDir(dir: string) {
  if (_createdImageDirs.size >= MAX_MEMOIZED_IMAGE_DIRS) _createdImageDirs.clear()
  _createdImageDirs.add(dir)
}

const FLASH_SYSTEM = `Answer in at most 5 sentences using only your training knowledge. Be direct and factual.
Do not search the web. If you cannot answer confidently, say so briefly.
Always respond in the same language the user used.`

const FLASH_MAX_TOKENS = parseInt(process.env.FLASH_MAX_TOKENS ?? '200')
const KEEPALIVE_INTERVAL_MS = 15000
const RESEARCHER_NOTES_CAP = 12000
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
  ephemeral: z.boolean().optional(),
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
      maxTokens: 120,
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
    console.error('[suggest]', e)
  }
  return c.json([])
})

chatRouter.post('/', rateLimitByUser(chatLimiter, 'chat'), zValidator('json', chatSchema), async (c) => {
  const userId = c.get('userId') as string
  const { sessionId, spaceId, messages: msgs, focusMode, searchCategories, includeFileIds, includeMemoryIds, ephemeral } = c.req.valid('json')
  const searchCategory = toSearxngCategories(searchCategories)
  const sid = sessionId ?? randomUUID()

  // Both ids come straight from the client: without these checks a known space id leaks
  // another user's memories into this answer, and a known session id appends to their chat.
  if (spaceId && !await ownsSpace(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  if (sessionId && await sessionOwnership(sessionId, userId) === 'other') return c.json({ error: 'Not found' }, 404)

  const abortSignal = c.req.raw.signal
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  const preview = (lastUser?.content ?? '').slice(0, 100).replace(/\n/g, ' ')
  console.log(`\n━━━ [${focusMode}] ${preview}`)

  // Settings are read once here rather than per branch: the cache key depends on the custom
  // prompt, so a personalised answer can never be served to a different user or context.
  const userRow = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get()
  const parsedSettings = parseSettings(userRow?.settings ?? '{}')
  const customPrompt = parsedSettings.customPrompt as string | undefined
  const cacheScope = [
    userId, spaceId ?? '',
    [...(includeFileIds ?? [])].sort().join(','),
    [...(includeMemoryIds ?? [])].sort().join(','),
    customPrompt ?? '',
  ].join('|')

  const ck = cacheKey(lastUser?.content ?? '', focusMode, cacheScope)
  const cached = getCached<string>(ck)
  if (cached) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: cached }) })
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, elapsedMs: 0 }) })
    })
  }

  if (focusMode === 'flash') {
    const [memoryBudget, ragBudget] = await Promise.all([
      spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(1000),
      spaceId ? getAppSetting('space_rag_budget', '500').then(Number) : Promise.resolve(0),
    ])
    const userQuery = lastUser?.content ?? ''
    const effectiveRag = (parsedSettings.useSpaceRag !== false) ? ragBudget : 0
    const { block: resolvedMemoryBlock, fileSources: flashFileSources } = spaceId ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, userQuery, includeFileIds, includeMemoryIds) : { block: '', fileSources: [] }
    const t0 = Date.now()
    let fullContent = ''
    return streamSSE(c, async (stream) => {
      if (flashFileSources.length > 0) await stream.writeSSE({ data: JSON.stringify({ type: 'file_sources', sources: flashFileSources }) })
      const flashSystem = FLASH_SYSTEM
        + (customPrompt ? `\n\nAdditional instructions:\n${customPrompt}` : '')
        + (resolvedMemoryBlock ? '\n\n' + resolvedMemoryBlock : '')
      const ctxLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
      const result = streamText({
        model: getFlashModel(),
        abortSignal,
        system: flashSystem,
        messages: trimMessages(msgs, Math.floor(ctxLimit * CONTEXT_RESERVE_FRACTION), flashSystem),
        maxTokens: FLASH_MAX_TOKENS,
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullContent += part.textDelta
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
        }
      }
      console.log(`  [flash] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)
      if (fullContent.length >= 50) setCached(ck, fullContent)
      if (!ephemeral) {
        const { title: sessionTitle } = await persistMessage(sid, userId, msgs, fullContent, [], spaceId)
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title: sessionTitle, elapsedMs: Date.now() - t0 }) })
        if (spaceId) {
          extractMemoriesPostHoc(spaceId, sid, lastUser?.content ?? '', fullContent).catch(e => console.error('[memory]', e))
          const newContents = [lastUser?.content, fullContent].filter(Boolean) as string[]
          indexContents(sid, newContents).catch(e => console.error('[chat-index]', e))
        }
      } else {
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, elapsedMs: Date.now() - t0 }) })
      }
    })
  }

  if (focusMode === 'image') {
    const imageBaseUrl = process.env.IMAGE_BASE_URL?.trim() || undefined
    if (!imageBaseUrl) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: 'Image generation is not configured. Set the IMAGE_BASE_URL environment variable to enable it.' }) })
        const { title: sessionTitle } = await persistMessage(sid, userId, msgs, '', [], spaceId)
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title: sessionTitle, elapsedMs: 0 }) })
      })
    }
    let pendingImageUrl: string | undefined
    const IMAGE_MD_RE = /!\[.*?\]\((\/images\/[\w-]+\/[\w-]+\.png)\)/g
    let lastGeneratedImageUrl: string | undefined
    for (const m of msgs) {
      for (const [, url] of (m.content as string).matchAll(IMAGE_MD_RE)) lastGeneratedImageUrl = url
    }
    const imageTools = {
      web_search: tool({
        description: 'Search the web for context about a specialized or unfamiliar subject before generating an image.',
        parameters: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) => {
          console.log(`  [image] web_search "${query}"`)
          const results = await webSearch(query)
          return results.map(r => `${r.title}: ${r.content}`).join('\n\n')
        },
      }),
      generate_image: tool({
        description: 'Generate an image from a text description using a local diffusion model.',
        parameters: z.object({
          prompt: z.string().describe('Detailed visual description for image generation'),
          size: z.string().optional().describe('Image dimensions e.g. "512x512", "1024x1024", "1024x576"'),
          steps: z.number().int().optional().describe('Inference steps: ~15 draft, ~25 balanced, ~40 high quality'),
        }),
        execute: async ({ prompt, size, steps }) => {
          try {
            const body: Record<string, unknown> = { prompt, n: 1, response_format: 'b64_json' }
            if (size) body.size = size
            if (steps) body.steps = steps
            if (process.env.IMAGE_MODEL) body.model = process.env.IMAGE_MODEL
            console.log(`  [image] → ${imageBaseUrl}  prompt="${prompt}"  size=${size ?? 'default'}  steps=${steps ?? 'default'}`)
            const res = await fetch(`${imageBaseUrl}/v1/images/generations`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
            })
            if (!res.ok) {
              console.error(`  [image] diffusion server error ${res.status}`)
              return { success: false, error: `Image server returned ${res.status}`, prompt }
            }
            const json = await res.json()
            const b64: string = json.data?.[0]?.b64_json
            if (!b64) {
              console.error(`  [image] no b64_json in response:`, JSON.stringify(json).slice(0, 200))
              return { success: false, error: 'No image data in response', prompt }
            }
            const imagesDir = `${IMAGE_STORAGE_DIR}/${userId}`
            if (!_createdImageDirs.has(imagesDir)) {
              await mkdir(imagesDir, { recursive: true })
              rememberImageDir(imagesDir)
            }
            const filename = `${randomUUID()}.png`
            await writeFile(`${imagesDir}/${filename}`, Buffer.from(b64, 'base64'))
            console.log(`  [image] saved ${userId}/${filename}`)
            pendingImageUrl = `/images/${userId}/${filename}`
            lastGeneratedImageUrl = pendingImageUrl
            return { success: true, prompt }
          } catch (e) {
            console.error(`  [image] error:`, e)
            return { success: false, error: String(e), prompt }
          }
        },
      }),
      edit_image: tool({
        description: 'Modify a previously generated image. Use when the user asks to change, edit, or iterate on an image.',
        parameters: z.object({
          image_url: z.string().describe('The /images/... URL of the image to edit (from chat history)'),
          prompt: z.string().describe('Full description of the desired result, including unchanged aspects'),
          strength: z.number().min(0).max(1).optional()
            .describe('How much to change (0.0=unchanged, 1.0=completely new). Default 0.75.'),
          size: z.string().optional().describe('Output dimensions e.g. "512x512". Defaults to source size.'),
          steps: z.number().int().optional().describe('Inference steps: ~15 draft, ~25 balanced, ~40 high'),
        }),
        execute: async ({ image_url, prompt, strength, size, steps }) => {
          try {
            if (!image_url.startsWith(`/images/${userId}/`)) {
              return { success: false, error: 'Invalid image reference', prompt }
            }
            const relPath = image_url.slice('/images/'.length)
            const imageBuffer = await readFile(`${IMAGE_STORAGE_DIR}/${relPath}`)
            const form = new FormData()
            form.append('image', new Blob([imageBuffer], { type: 'image/png' }), 'image.png')
            form.append('prompt', prompt)
            form.append('n', '1')
            form.append('response_format', 'b64_json')
            if (strength !== undefined) form.append('strength', String(strength))
            if (size) form.append('size', size)
            if (steps) form.append('steps', String(steps))
            if (process.env.IMAGE_MODEL) form.append('model', process.env.IMAGE_MODEL)
            console.log(`  [image] edit → ${imageBaseUrl}  prompt="${prompt}"  strength=${strength ?? 0.75}`)
            const res = await fetch(`${imageBaseUrl}/v1/images/edits`, { method: 'POST', body: form, signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) })
            if (!res.ok) {
              console.error(`  [image] edit server error ${res.status}`)
              return { success: false, error: `Image server returned ${res.status}`, prompt }
            }
            const json = await res.json()
            const b64: string = json.data?.[0]?.b64_json
            if (!b64) {
              console.error(`  [image] no b64_json in edit response:`, JSON.stringify(json).slice(0, 200))
              return { success: false, error: 'No image data in response', prompt }
            }
            const imagesDir = `${IMAGE_STORAGE_DIR}/${userId}`
            if (!_createdImageDirs.has(imagesDir)) {
              await mkdir(imagesDir, { recursive: true })
              rememberImageDir(imagesDir)
            }
            const filename = `${randomUUID()}.png`
            await writeFile(`${imagesDir}/${filename}`, Buffer.from(b64, 'base64'))
            console.log(`  [image] saved edited ${userId}/${filename}`)
            pendingImageUrl = `/images/${userId}/${filename}`
            lastGeneratedImageUrl = pendingImageUrl
            return { success: true, prompt }
          } catch (e) {
            console.error(`  [image] edit error:`, e)
            return { success: false, error: String(e), prompt }
          }
        },
      }),
    }
    const imageSystem = `You are an image generation assistant.
- When asked to draw, illustrate, create, or generate an image, call generate_image with a detailed visual prompt.
- When asked to edit, change, or modify a previously generated image, call edit_image.${lastGeneratedImageUrl ? ` The most recently generated image is at ${lastGeneratedImageUrl}.` : ''}
- If the subject is specialized, technical, or you are uncertain what it looks like visually, call web_search first to gather context, then use what you learned to write a richer prompt.
- Extract size from resolution strings and steps from quality hints (draft→15, balanced→25, high→40).
- If you used web_search, respond with one sentence summarizing what you learned that shaped the prompt. Otherwise output nothing — do not add any text, URLs, or commentary after the image tool call.
- Always respond in the same language the user used.`
    const t0 = Date.now()
    let fullContent = ''
    return streamSSE(c, async (stream) => {
      const ctxLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
      const result = streamText({
        model: getFlashModel(),
        abortSignal,
        system: imageSystem,
        messages: trimMessages(msgs, Math.floor(ctxLimit * CONTEXT_RESERVE_FRACTION), imageSystem),
        tools: imageTools,
        maxSteps: 4,
        maxTokens: RESEARCH_MAX_TOKENS,
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullContent += part.textDelta
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
        } else if (part.type === 'tool-call') {
          if (part.toolName === 'web_search') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'status', text: 'Researching topic…' }) })
          } else if (part.toolName === 'generate_image') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'status', text: 'Generating image…' }) })
          } else if (part.toolName === 'edit_image') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'status', text: 'Editing image…' }) })
          }
        } else if (part.type === 'tool-result' && (part.toolName === 'generate_image' || part.toolName === 'edit_image')) {
          const r = part.result as { success?: boolean; prompt?: string; error?: string }
          if (r.success && pendingImageUrl) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'image', url: pendingImageUrl, alt: r.prompt ?? '' }) })
            fullContent += `\n\n![${r.prompt ?? ''}](${pendingImageUrl})`
            pendingImageUrl = undefined
          }
        }
      }
      console.log(`  [image] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)
      if (!ephemeral) {
        const { title: sessionTitle } = await persistMessage(sid, userId, msgs, fullContent, [], spaceId)
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title: sessionTitle, elapsedMs: Date.now() - t0 }) })
        if (spaceId) {
          extractMemoriesPostHoc(spaceId, sid, lastUser?.content ?? '', fullContent).catch(e => console.error('[memory]', e))
          const newContents = [lastUser?.content, fullContent].filter(Boolean) as string[]
          indexContents(sid, newContents).catch(e => console.error('[chat-index]', e))
        }
      } else {
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, elapsedMs: Date.now() - t0 }) })
      }
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

  const [fetchMaxPages, fetchSummarize, compressHistory] = await Promise.all([
    getAppSetting('fetch_max_pages', '8').then(Number),
    getAppSetting('fetch_summarize_overflow', 'false').then(v => v === 'true'),
    getAppSetting('compress_history_overflow', 'false').then(v => v === 'true'),
  ])

  // Shared per-request allowance for paid keyed-API fallback searches (pre-search + researcher).
  const apiBudget: SearchApiBudget = { remaining: parseInt(process.env.SEARCH_API_MAX_PER_REQUEST ?? '3', 10) }

  // Fetch user settings + file count + reformulate/pre-search + memory + URL prefetch in parallel
  const [fileCountRow, { initialQueries, initialResults, engineErrors }, memoryBudget, ragBudget, prefetchedUrls] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(uploadedFiles).where(eq(uploadedFiles.userId, userId)).get(),
    runReformulateAndPreSearch(msgsForReformulate, focusMode as 'balanced' | 'thorough', hasAttachment, searchCategory, apiBudget),
    spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(1000),
    getAppSetting('space_rag_budget', '500').then(Number),
    prefetchUrlsFromMessage(lastUser?.content ?? '', hasAttachment, fetchMaxPages),
  ])
  const userQuery = lastUser?.content ?? ''
  const hasFiles = (fileCountRow?.count ?? 0) > 0
  const effectiveRag = (parsedSettings.useSpaceRag !== false) ? ragBudget : 0
  const { block: memoryBlock, fileSources } = spaceId
    ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, userQuery, includeFileIds, includeMemoryIds)
    : (hasFiles && parsedSettings.useChatRag !== false)
      ? await buildChatFileBlock(userId, userQuery, ragBudget)
      : { block: '', fileSources: [] }
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
    ? await processUrlsForContext(prefetchedUrls, urlBudgetChars, fetchSummarize)
    : prefetchedUrls

  return streamSSE(c, async (stream) => {
    let fullContent = ''
    const sources: unknown[] = []

    if (fileSources.length > 0) await stream.writeSSE({ data: JSON.stringify({ type: 'file_sources', sources: fileSources }) })

    const emitStatus = (text: string) =>
      stream.writeSSE({ data: JSON.stringify({ type: 'status', text }) })

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
      await stream.writeSSE({ data: JSON.stringify({ type: 'search_warning', engines: fresh.map(e => ({ engine: e.engine, reason: e.reason })) }) })
    }
    if (!initialResults?.length && engineErrors?.length) await warnEngineErrors(engineErrors)

    const emitSearchStatus = (args: { queries?: string[]; query?: string }) => {
      const queries: string[] = args.queries ?? (args.query ? [args.query] : [])
      if (queries.length) emitStatus(`Searching: ${queries.map(q => `"${q}"`).join(', ')}`)
    }

    if (focusMode === 'thorough') {
      // Phase 1: Research (collect sources, no text to client)
      if (processedUrls.length) await emitStatus(`Reading: ${processedUrls.map(f => new URL(f.url).hostname).join(', ')}`)
      if (initialQueries?.length) {
        await emitStatus(`Searching: ${initialQueries.map(q => `"${q}"`).join(', ')}`)
        if (showThinking) {
          await stream.writeSSE({ data: JSON.stringify({ type: 'thinking',
            delta: `🔍 Searching: ${initialQueries.map(q => `"${q}"`).join(', ')}\n` }) })
        }
      }
      if (showThinking && initialResults?.length) {
        const snippets = initialResults.slice(0, 3)
          .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
          .join('\n')
        await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: snippets + '\n\n' }) })
      }
      const researchModel = useThinking ? getThinkingModelOrFallback() : getChatModel()
      const researcherResult = await runResearcher({ messages: msgs, focusMode, userId, model: researchModel, abortSignal, initialQueries, initialResults, prefetchedUrls: processedUrls, customPrompt, hasFiles, spaceId, sessionId: sid, memoryBlock, fetchSummarize, compressHistory, onEngineErrors: warnEngineErrors, apiBudget })
      const allSources: SearchResult[] = [...(initialResults ?? [])]
      let researcherNotes = ''
      const thoroughExtractor = useThinking ? new ThinkExtractor() : null

      const keepalive = setInterval(() => {
        stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }).catch(() => {})
      }, KEEPALIVE_INTERVAL_MS)
      try {
        await drainResearcherStream(researcherResult, {
          stream, showThinking, emitSearchStatus,
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

      let finalSources = dedupedSources
      if (rerankEnabled && dedupedSources.length > 0) {
        const userQuery = msgs.findLast(m => m.role === 'user')?.content ?? ''
        const t = performance.now()
        const indices = await rerank(userQuery, dedupedSources.map(s => s.content), dedupedSources.length)
        finalSources = indices.map(i => dedupedSources[i])
        console.log(`  [reranker] ${dedupedSources.length} → ${finalSources.length} sources in ${Math.round(performance.now() - t)}ms`)
      }

      sources.push(...finalSources)
      await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: finalSources }) })

      // Phase 2: Writer pass
      await emitStatus('Writing answer…')
      const writerResult = runWriter(finalSources, msgs, researcherNotes.slice(0, RESEARCHER_NOTES_CAP), abortSignal)
      const writerExtractor = new ThinkExtractor()
      for await (const part of writerResult.fullStream) {
        if (part.type === 'text-delta') {
          const { text, thinking } = writerExtractor.process(part.textDelta)
          if (thinking && showThinking) await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: thinking }) })
          if (text) {
            fullContent += text
            await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: text }) })
          }
        } else if (part.type === 'reasoning' && showThinking) {
          await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: part.textDelta }) })
        } else if ((part as { type: string }).type === 'error') {
          console.error('  [writer] stream error:', (part as { error: unknown }).error)
        }
      }
      const { text: wt, thinking: wth } = writerExtractor.flush()
      if (wth && showThinking) await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: wth }) })
      if (wt) {
        fullContent += wt
        await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: wt }) })
      }
      if (!fullContent) {
        console.error('  [writer] produced 0 chars — model may be in a bad state')
        await emitStatus('Model returned empty response. Try again or restart the model server.')
      }
    } else {
      // Speed / balanced: stream researcher output directly
      if (processedUrls.length) await emitStatus(`Reading: ${processedUrls.map(f => new URL(f.url).hostname).join(', ')}`)
      if (initialQueries?.length) {
        await emitStatus(`Searching: ${initialQueries.map(q => `"${q}"`).join(', ')}`)
        if (showThinking) {
          await stream.writeSSE({ data: JSON.stringify({ type: 'thinking',
            delta: `🔍 Searching: ${initialQueries.map(q => `"${q}"`).join(', ')}\n` }) })
        }
      }
      if (initialResults?.length) {
        if (showThinking) {
          const snippets = initialResults.slice(0, 3)
            .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
            .join('\n')
          await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: snippets + '\n\n' }) })
        }
        sources.push(...initialResults.map(r => ({ title: r.title, url: r.url })))
        await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: initialResults }) })
      }

      const fullSources: SearchResult[] = []
      const result = await runResearcher({ messages: msgs, focusMode, userId, model: getChatModel(), abortSignal, initialQueries, initialResults, prefetchedUrls: processedUrls, customPrompt, hasFiles, spaceId, sessionId: sid, memoryBlock, fetchSummarize, compressHistory, onEngineErrors: warnEngineErrors, apiBudget })
      const extractor = showThinking ? new ThinkExtractor() : null

      const keepalive = setInterval(() => {
        stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }).catch(() => {})
      }, KEEPALIVE_INTERVAL_MS)
      let drainFinishReason: string | undefined
      try {
        drainFinishReason = await drainResearcherStream(result, {
          stream, showThinking, emitSearchStatus,
          extractor,
          onText: async (text) => {
            fullContent += text
            await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: text }) })
          },
          onSources: async (results) => {
            fullSources.push(...results)
            sources.push(...results.map(r => ({ title: r.title, url: r.url })))
            await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: results }) })
          },
        })
      } finally {
        clearInterval(keepalive)
      }

      // Fallback: if the researcher exhausted its step budget on tool calls, synthesise an answer.
      // finishReason=tool-calls means the model's last action was a tool call, not a final answer —
      // so any accumulated content is just intermediate reasoning preamble, not a real response.
      if (drainFinishReason === 'tool-calls') {
        console.warn('  [balanced] maxSteps exhausted without answer — running no-tool synthesis fallback')
        await emitStatus('Synthesising answer…')
        const allResults = [...(initialResults ?? []), ...fullSources]
        const resultsBlock = allResults.length > 0
          ? '\n\nSearch results:\n' + allResults.map((r, i) => {
              const idx = (r as SearchResult & { index?: number }).index ?? (i + 1)
              return `[${idx}] ${r.title}\n${r.url}\n${r.content.slice(0, 500)}`
            }).join('\n\n')
          : ''
        const fallback = streamText({
          model: getChatModel(),
          system: `Today's date is ${new Date().toISOString().split('T')[0]}. Synthesize the search results below into a direct answer with inline [N] citations using the index values shown. Do NOT say you lack internet access. Search results are authoritative ground truth — if they describe a product or release you don't recognise, trust them; your training data has a cutoff.${resultsBlock}${memoryBlock ? '\n\n' + memoryBlock : ''}`,
          messages: msgs,
          abortSignal,
          maxTokens: RESEARCH_MAX_TOKENS,
        })
        for await (const part of fallback.fullStream) {
          const p = part as { type: string; textDelta?: string }
          if (p.type === 'text-delta' && p.textDelta) {
            fullContent += p.textDelta
            await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: p.textDelta }) })
          }
        }
      }
    }

    if (fullContent.length < 50) console.log(`  [debug] short content: ${JSON.stringify(fullContent)}`)
    console.log(`  [${focusMode}] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)

    if (fullContent.length >= 50) setCached(ck, fullContent)
    if (!ephemeral) {
      const { title: sessionTitle } = await persistMessage(sid, userId, msgs, fullContent, sources, spaceId)
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title: sessionTitle, elapsedMs: Date.now() - t0 }) })
      if (spaceId) {
        extractMemoriesPostHoc(spaceId, sid, lastUser?.content ?? '', fullContent).catch(e => console.error('[memory]', e))
        const newContents = [lastUser?.content, fullContent].filter(Boolean) as string[]
        indexContents(sid, newContents).catch(e => console.error('[chat-index]', e))
      }
    } else {
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, elapsedMs: Date.now() - t0 }) })
    }
  })
})

type SSEStream = { writeSSE: (opts: { data: string }) => Promise<void> }

/** Drains a researcher fullStream, routing parts to the appropriate outputs.
 *  onText receives extracted text content (researcher notes or answer text).
 *  onSources receives web_search tool results.
 *  Set emitTextAsThinking=true (thorough researcher) to mirror text into the thinking channel. */
async function drainResearcherStream(
  researcherResult: { fullStream: AsyncIterable<unknown> },
  {
    stream, showThinking, emitSearchStatus, extractor, onText, onSources, emitTextAsThinking = false,
  }: {
    stream: SSEStream
    showThinking: boolean
    emitSearchStatus: (args: { queries?: string[]; query?: string }) => void | Promise<void>
    extractor: ThinkExtractor | null
    onText: (text: string) => void | Promise<void>
    onSources: (results: SearchResult[]) => void | Promise<void>
    emitTextAsThinking?: boolean
  },
): Promise<string> {
  const emitThinking = (delta: string) =>
    stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta }) })

  let textDeltaCount = 0, reasoningCount = 0, finishReason = 'unknown'
  for await (const _part of researcherResult.fullStream) {
    const part = _part as { type: string; toolName?: string; args?: { queries?: string[]; query?: string }; result?: unknown; textDelta?: string; error?: unknown; finishReason?: string }
    if (part.type === 'finish' || part.type === 'step-finish') {
      if (part.finishReason) finishReason = part.finishReason
    } else if (part.type === 'tool-call' && part.toolName === 'web_search') {
      await emitSearchStatus(part.args ?? {})
      if (showThinking) {
        const queries: string[] = part.args?.queries ?? (part.args?.query ? [part.args.query] : [])
        await emitThinking(`🔍 Searching: ${queries.map((q: string) => `"${q}"`).join(', ')}\n`)
      }
    } else if (part.type === 'tool-call' && part.toolName === 'uploads_search') {
      console.log(`  [uploads_search] query: ${JSON.stringify(part.args?.query ?? '')}`)
    } else if (part.type === 'tool-result' && part.toolName === 'uploads_search') {
      const results = part.result as Array<{ filename?: string; content?: string }> | undefined
      console.log(`  [uploads_search] returned ${results?.length ?? 0} chunks`)
    } else if (part.type === 'tool-call' && part.toolName === 'save_to_memory') {
      await stream.writeSSE({ data: JSON.stringify({ type: 'status', text: 'Saving to memory…' }) })
    } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
      // result may be a non-array "search unavailable" message when search is exhausted.
      const results = (Array.isArray(part.result) ? part.result : []) as SearchResult[]
      await onSources(results)
      if (showThinking) {
        const snippets = results.slice(0, 3)
          .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
          .join('\n')
        await emitThinking(snippets + '\n\n')
      }
    } else if (part.type === 'reasoning') {
      reasoningCount++
      if (showThinking) await emitThinking(part.textDelta ?? '')
    } else if (part.type === 'text-delta') {
      textDeltaCount++
      if (extractor) {
        const { text, thinking } = extractor.process(part.textDelta ?? '')
        if (thinking && showThinking) await emitThinking(thinking)
        if (text) {
          if (emitTextAsThinking && showThinking) await emitThinking(text)
          await onText(text)
        }
      } else {
        if (emitTextAsThinking && showThinking) await emitThinking(part.textDelta ?? '')
        await onText(part.textDelta ?? '')
      }
    } else if (part.type === 'error') {
      console.error('  [researcher] stream error:', part.error)
    }
  }
  if (extractor) {
    const { text, thinking } = extractor.flush()
    if (thinking && showThinking) await emitThinking(thinking)
    if (text) {
      if (emitTextAsThinking && showThinking) await emitThinking(text)
      await onText(text)
    }
  }
  console.log(`  [drain] textDelta=${textDeltaCount} reasoning=${reasoningCount} finishReason=${finishReason}`)
  return finishReason
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)]
    .map(m => m[0].replace(/[.,;!?]+$/, ''))
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, 2)
}

async function prefetchUrlsFromMessage(text: string, hasAttachment: boolean, maxPages = 8): Promise<Array<{ url: string; content: string }>> {
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
    const queries = await reformulateLLM(msgsForReformulate, focusMode)
    if (queries.length === 0) return {}

    const maxQueries = focusMode === 'thorough' ? 3 : 2
    const initialResults = await webSearchMulti(queries.slice(0, maxQueries), countEach, categories, collect, apiBudget)
    return { initialQueries: queries, initialResults, engineErrors: engineErrors() }
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
  spaceId?: string,
): Promise<{ title: string }> {
  const now = new Date()
  const title = msgs.find(m => m.role === 'user')?.content.slice(0, SESSION_TITLE_MAX) ?? 'Chat'
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')

  await db.transaction(async (tx) => {
    await tx.insert(chatSessions).values({ id: sessionId, title, createdAt: now, updatedAt: now, userId, spaceId: spaceId ?? null })
      .onConflictDoUpdate({ target: chatSessions.id, set: { updatedAt: now, graduated: 1 } })
    if (lastUser) {
      await tx.insert(messages).values({ id: randomUUID(), sessionId, role: 'user', content: lastUser.content, createdAt: now })
    }
    await tx.insert(messages).values({ id: randomUUID(), sessionId, role: 'assistant', content: assistantContent, sources: JSON.stringify(sources), createdAt: now })
  })

  return { title }
}
