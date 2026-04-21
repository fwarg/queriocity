import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { streamText, tool } from 'ai'
import { runResearcher } from '../lib/researcher.ts'
import { runWriter } from '../lib/writer.ts'
import { reformulateSpeed, reformulateLLM } from '../lib/reformulate.ts'
import { cacheKey, getCached, setCached } from '../lib/cache.ts'
import { db, chatSessions, messages, users, uploadedFiles, parseSettings, getAppSetting } from '../lib/db.ts'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { webSearch, webSearchMulti, type SearchResult } from '../lib/searxng.ts'
import { getFlashModel, getChatModel, getThinkingModelOrFallback } from '../lib/llm.ts'
import { ThinkExtractor } from '../lib/think-extractor.ts'
import { rerank, rerankEnabled } from '../lib/reranker.ts'
import { buildMemoryBlock, buildChatFileBlock, extractMemoriesPostHoc } from '../lib/memory.ts'
import { trimMessages } from '../lib/trim-messages.ts'
import { indexContents } from '../lib/chat-indexer.ts'
import { IMAGE_STORAGE_DIR } from '../lib/image-store.ts'
const _createdImageDirs = new Set<string>()

const FLASH_SYSTEM = `Answer in at most 5 sentences using only your training knowledge. Be direct and factual.
Do not search the web. If you cannot answer confidently, say so briefly.
Always respond in the same language the user used.`

const FLASH_MAX_TOKENS = 200
const KEEPALIVE_INTERVAL_MS = 15000
const RESEARCHER_NOTES_CAP = 2000
const SESSION_TITLE_MAX = 60

const chatSchema = z.object({
  sessionId: z.string().optional(),
  spaceId: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  focusMode: z.enum(['flash', 'fast', 'balanced', 'thorough']).default('balanced'),
})

export const chatRouter = new Hono<AppEnv>()

chatRouter.use('*', authMiddleware)

chatRouter.post('/', zValidator('json', chatSchema), async (c) => {
  const userId = c.get('userId') as string
  const { sessionId, spaceId, messages: msgs, focusMode } = c.req.valid('json')
  const sid = sessionId ?? randomUUID()

  const abortSignal = c.req.raw.signal
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  const preview = (lastUser?.content ?? '').slice(0, 100).replace(/\n/g, ' ')
  console.log(`\n━━━ [${focusMode}] ${preview}`)

  const ck = cacheKey(lastUser?.content ?? '', focusMode)
  const cached = getCached<string>(ck)
  if (cached) {
    return c.json({ cached: true, content: cached })
  }

  if (focusMode === 'flash') {
    const [userRow, memoryBudget, ragBudget] = await Promise.all([
      db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
      spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(1000),
      spaceId ? getAppSetting('space_rag_budget', '500').then(Number) : Promise.resolve(0),
    ])
    const userQuery = lastUser?.content ?? ''
    const parsedFlashSettings = parseSettings(userRow?.settings ?? '{}')
    const effectiveRag = (parsedFlashSettings.useSpaceRag !== false) ? ragBudget : 0
    const { block: resolvedMemoryBlock, fileSources: flashFileSources } = spaceId ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, userQuery) : { block: '', fileSources: [] }
    const customPrompt: string | undefined = parsedFlashSettings.customPrompt as string | undefined
    const imageBaseUrl = process.env.IMAGE_BASE_URL?.trim() || undefined
    let pendingImageUrl: string | undefined
    const imageTools = imageBaseUrl ? {
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
              _createdImageDirs.add(imagesDir)
            }
            const filename = `${randomUUID()}.png`
            await writeFile(`${imagesDir}/${filename}`, Buffer.from(b64, 'base64'))
            console.log(`  [image] saved ${userId}/${filename}`)
            pendingImageUrl = `/images/${userId}/${filename}`
            return { success: true, prompt }
          } catch (e) {
            console.error(`  [image] error:`, e)
            return { success: false, error: String(e), prompt }
          }
        },
      }),
    } : undefined
    const t0 = Date.now()
    let fullContent = ''
    return streamSSE(c, async (stream) => {
      if (flashFileSources.length > 0) await stream.writeSSE({ data: JSON.stringify({ type: 'file_sources', sources: flashFileSources }) })
      const imagePrefix = imageBaseUrl
        ? 'You have a generate_image tool. When the user asks to draw, create, illustrate, or generate an image, call generate_image immediately. Extract size from resolutions like "512x512" and steps from quality hints (draft→15, balanced→25, high→40). Do not say you cannot generate images.\n\n'
        : ''
      const flashSystem = imagePrefix
        + (imageBaseUrl ? FLASH_SYSTEM.replace('using only your training knowledge', 'using your knowledge and available tools') : FLASH_SYSTEM)
        + (customPrompt ? `\n\nAdditional instructions:\n${customPrompt}` : '')
        + (resolvedMemoryBlock ? '\n\n' + resolvedMemoryBlock : '')
      const ctxLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
      let hasImage = false
      const result = streamText({
        model: getFlashModel(),
        abortSignal,
        system: flashSystem,
        messages: trimMessages(msgs, ctxLimit - Math.floor(ctxLimit * 0.2), flashSystem),
        ...(imageTools ? { tools: imageTools, maxSteps: 2 } : { maxTokens: FLASH_MAX_TOKENS }),
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullContent += part.textDelta
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
        } else if (part.type === 'tool-call' && part.toolName === 'generate_image') {
          await stream.writeSSE({ data: JSON.stringify({ type: 'status', text: 'Generating image…' }) })
        } else if (part.type === 'tool-result' && part.toolName === 'generate_image') {
          const r = part.result as { success?: boolean; prompt?: string; error?: string }
          if (r.success && pendingImageUrl) {
            hasImage = true
            await stream.writeSSE({ data: JSON.stringify({ type: 'image', url: pendingImageUrl, alt: r.prompt ?? '' }) })
            fullContent += `\n\n![${r.prompt ?? ''}](${pendingImageUrl})`
            pendingImageUrl = undefined
          }
        }
      }
      console.log(`  [flash] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)
      if (!hasImage && fullContent.length >= 50) setCached(ck, fullContent)
      const { title: sessionTitle } = await persistMessage(sid, userId, msgs, fullContent, [], spaceId)
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title: sessionTitle, elapsedMs: Date.now() - t0 }) })
      if (spaceId) {
        extractMemoriesPostHoc(spaceId, sid, lastUser?.content ?? '', fullContent).catch(e => console.error('[memory]', e))
        const newContents = [lastUser?.content, fullContent].filter(Boolean) as string[]
        indexContents(sid, newContents).catch(e => console.error('[chat-index]', e))
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

  // Fetch user settings + file count + reformulate/pre-search + memory in parallel
  const [userRow, fileCountRow, { initialQueries, initialResults }, memoryBudget, ragBudget] = await Promise.all([
    db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
    db.select({ count: sql<number>`count(*)` }).from(uploadedFiles).where(eq(uploadedFiles.userId, userId)).get(),
    runReformulateAndPreSearch(msgsForReformulate, focusMode as 'fast' | 'balanced' | 'thorough', hasAttachment),
    spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(1000),
    getAppSetting('space_rag_budget', '500').then(Number),
  ])
  const userQuery = lastUser?.content ?? ''
  const parsedSettings = parseSettings(userRow?.settings ?? '{}')
  const hasFiles = (fileCountRow?.count ?? 0) > 0
  const effectiveRag = (parsedSettings.useSpaceRag !== false) ? ragBudget : 0
  const { block: memoryBlock, fileSources } = spaceId
    ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, userQuery)
    : (hasFiles && parsedSettings.useChatRag !== false)
      ? await buildChatFileBlock(userId, userQuery, ragBudget)
      : { block: '', fileSources: [] }
  const customPrompt = parsedSettings.customPrompt as string | undefined
  const showThinkingSettings = (parsedSettings.showThinking ?? { balanced: false, thorough: false }) as { balanced: boolean; thorough: boolean }
  const showThinking = focusMode === 'balanced' ? showThinkingSettings.balanced
                     : focusMode === 'thorough'  ? showThinkingSettings.thorough
                     : false
  const useThinking: boolean = !!(parsedSettings.useThinking) && focusMode === 'thorough'

  return streamSSE(c, async (stream) => {
    let fullContent = ''
    const sources: unknown[] = []

    if (fileSources.length > 0) await stream.writeSSE({ data: JSON.stringify({ type: 'file_sources', sources: fileSources }) })

    const emitStatus = (text: string) =>
      stream.writeSSE({ data: JSON.stringify({ type: 'status', text }) })

    const emitSearchStatus = (args: { queries?: string[]; query?: string }) => {
      const queries: string[] = args.queries ?? (args.query ? [args.query] : [])
      if (queries.length) emitStatus(`Searching: ${queries.map(q => `"${q}"`).join(', ')}`)
    }

    if (focusMode === 'thorough') {
      // Phase 1: Research (collect sources, no text to client)
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
      const researcherResult = runResearcher({ messages: msgs, focusMode, userId, model: researchModel, abortSignal, initialQueries, initialResults, customPrompt, hasFiles, spaceId, sessionId: sid, memoryBlock })
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

      const result = runResearcher({ messages: msgs, focusMode, userId, model: getChatModel(), abortSignal, initialQueries, initialResults, customPrompt, hasFiles, spaceId, sessionId: sid, memoryBlock })
      const extractor = showThinking ? new ThinkExtractor() : null

      await drainResearcherStream(result, {
        stream, showThinking, emitSearchStatus,
        extractor,
        onText: async (text) => {
          fullContent += text
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: text }) })
        },
        onSources: async (results) => {
          sources.push(...results.map(r => ({ title: r.title, url: r.url })))
          await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: results }) })
        },
      })
    }

    if (fullContent.length < 50) console.log(`  [debug] short content: ${JSON.stringify(fullContent)}`)
    console.log(`  [${focusMode}] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)

    // Persist to DB
    const { title: sessionTitle } = await persistMessage(sid, userId, msgs, fullContent, sources, spaceId)

    if (fullContent.length >= 50) setCached(ck, fullContent)
    await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title: sessionTitle, elapsedMs: Date.now() - t0 }) })
    if (spaceId) {
      extractMemoriesPostHoc(spaceId, sid, lastUser?.content ?? '', fullContent).catch(e => console.error('[memory]', e))
      const newContents = [lastUser?.content, fullContent].filter(Boolean) as string[]
      indexContents(sid, newContents).catch(e => console.error('[chat-index]', e))
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
) {
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
      const results = (part.result ?? []) as SearchResult[]
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
}

async function runReformulateAndPreSearch(
  msgsForReformulate: Array<{ role: string; content: string }>,
  focusMode: 'fast' | 'balanced' | 'thorough', // flash handled before this point
  hasAttachment: boolean,
): Promise<{ initialQueries?: string[]; initialResults?: SearchResult[] }> {
  try {
    if (hasAttachment) {
      console.log(`  [chat] attachment detected — skipping reformulation/pre-search`)
      return {}
    }
    if (focusMode === 'fast') {
      const q = reformulateSpeed(msgsForReformulate)
      if (!q) return {}
      const initialResults = await webSearch(q, 6)
      return { initialQueries: [q], initialResults }
    }

    const countEach = focusMode === 'thorough' ? 10 : 6
    const queries = await reformulateLLM(msgsForReformulate, focusMode)
    if (queries.length === 0) return {}

    const maxQueries = focusMode === 'thorough' ? 3 : 2
    const initialResults = await webSearchMulti(queries.slice(0, maxQueries), countEach)
    return { initialQueries: queries, initialResults }
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
      .onConflictDoNothing()
    if (lastUser) {
      await tx.insert(messages).values({ id: randomUUID(), sessionId, role: 'user', content: lastUser.content, createdAt: now })
    }
    await tx.insert(messages).values({ id: randomUUID(), sessionId, role: 'assistant', content: assistantContent, sources: JSON.stringify(sources), createdAt: now })
  })

  return { title }
}
