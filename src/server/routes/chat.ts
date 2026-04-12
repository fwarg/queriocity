import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { streamText } from 'ai'
import { runResearcher } from '../lib/researcher.ts'
import { runWriter } from '../lib/writer.ts'
import { reformulateSpeed, reformulateLLM } from '../lib/reformulate.ts'
import { cacheKey, getCached, setCached } from '../lib/cache.ts'
import { db, chatSessions, messages, users, uploadedFiles, parseSettings, getAppSetting } from '../lib/db.ts'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { webSearch, webSearchMulti, type SearchResult } from '../lib/searxng.ts'
import { getFlashModel, getChatModel, getThinkingModelOrFallback } from '../lib/llm.ts'
import { ThinkExtractor } from '../lib/think-extractor.ts'
import { rerank, rerankEnabled } from '../lib/reranker.ts'
import { buildMemoryBlock, extractMemoriesPostHoc } from '../lib/memory.ts'

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
    const [userRow, memoryBudget] = await Promise.all([
      db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
      spaceId ? getAppSetting('memory_token_budget', '1000').then(v => parseInt(v)) : Promise.resolve(1000),
    ])
    const resolvedMemoryBlock = spaceId ? await buildMemoryBlock(spaceId, memoryBudget) : ''
    const customPrompt: string | undefined = userRow ? (parseSettings(userRow.settings).customPrompt as string | undefined) : undefined
    const t0 = Date.now()
    let fullContent = ''
    return streamSSE(c, async (stream) => {
      const result = streamText({
        model: getFlashModel(),
        abortSignal,
        system: FLASH_SYSTEM
          + (customPrompt ? `\n\nAdditional instructions:\n${customPrompt}` : '')
          + (resolvedMemoryBlock ? '\n\n' + resolvedMemoryBlock : ''),
        messages: msgs,
        maxTokens: FLASH_MAX_TOKENS,
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullContent += part.textDelta
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
        }
      }
      console.log(`  [flash] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)
      setCached(ck, fullContent)
      const { title: sessionTitle } = await persistMessage(sid, userId, msgs, fullContent, [], spaceId)
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title: sessionTitle, elapsedMs: Date.now() - t0 }) })
      if (spaceId) extractMemoriesPostHoc(spaceId, sid, lastUser?.content ?? '', fullContent).catch(e => console.error('[memory]', e))
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
  const [userRow, fileCountRow, { initialQueries, initialResults }, memoryBudget] = await Promise.all([
    db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
    db.select({ count: sql<number>`count(*)` }).from(uploadedFiles).where(eq(uploadedFiles.userId, userId)).get(),
    runReformulateAndPreSearch(msgsForReformulate, focusMode as 'fast' | 'balanced' | 'thorough', hasAttachment),
    spaceId ? getAppSetting('memory_token_budget', '1000').then(v => parseInt(v)) : Promise.resolve(1000),
  ])
  const memoryBlock = spaceId ? await buildMemoryBlock(spaceId, memoryBudget) : ''
  const parsedSettings = parseSettings(userRow?.settings ?? '{}')
  const customPrompt = parsedSettings.customPrompt as string | undefined
  const showThinkingSettings = (parsedSettings.showThinking ?? { balanced: false, thorough: false }) as { balanced: boolean; thorough: boolean }
  const showThinking = focusMode === 'balanced' ? showThinkingSettings.balanced
                     : focusMode === 'thorough'  ? showThinkingSettings.thorough
                     : false
  const useThinking: boolean = !!(parsedSettings.useThinking) && focusMode === 'thorough'
  const hasFiles = (fileCountRow?.count ?? 0) > 0

  return streamSSE(c, async (stream) => {
    let fullContent = ''
    const sources: unknown[] = []

    const emitStatus = (text: string) =>
      stream.writeSSE({ data: JSON.stringify({ type: 'status', text }) })

    const emitSearchStatus = (args: any) => {
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
        } else if ((part as any).type === 'error') {
          console.error('  [writer] stream error:', (part as any).error)
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

    console.log(`  [${focusMode}] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)

    // Persist to DB
    const { title: sessionTitle } = await persistMessage(sid, userId, msgs, fullContent, sources, spaceId)

    setCached(ck, fullContent)
    await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, title: sessionTitle, elapsedMs: Date.now() - t0 }) })
    if (spaceId) extractMemoriesPostHoc(spaceId, sid, lastUser?.content ?? '', fullContent).catch(e => console.error('[memory]', e))
  })
})

type SSEStream = { writeSSE: (opts: { data: string }) => Promise<void> }

/** Drains a researcher fullStream, routing parts to the appropriate outputs.
 *  onText receives extracted text content (researcher notes or answer text).
 *  onSources receives web_search tool results.
 *  Set emitTextAsThinking=true (thorough researcher) to mirror text into the thinking channel. */
async function drainResearcherStream(
  researcherResult: { fullStream: AsyncIterable<any> },
  {
    stream, showThinking, emitSearchStatus, extractor, onText, onSources, emitTextAsThinking = false,
  }: {
    stream: SSEStream
    showThinking: boolean
    emitSearchStatus: (args: any) => void | Promise<void>
    extractor: ThinkExtractor | null
    onText: (text: string) => void | Promise<void>
    onSources: (results: SearchResult[]) => void | Promise<void>
    emitTextAsThinking?: boolean
  },
) {
  const emitThinking = (delta: string) =>
    stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta }) })

  for await (const part of researcherResult.fullStream as AsyncIterable<any>) {
    if (part.type === 'tool-call' && part.toolName === 'web_search') {
      await emitSearchStatus(part.args)
      if (showThinking) {
        const queries: string[] = part.args.queries ?? (part.args.query ? [part.args.query] : [])
        await emitThinking(`🔍 Searching: ${queries.map((q: string) => `"${q}"`).join(', ')}\n`)
      }
    } else if (part.type === 'tool-call' && part.toolName === 'save_to_memory') {
      await stream.writeSSE({ data: JSON.stringify({ type: 'status', text: 'Saving to memory…' }) })
    } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
      const results = part.result as SearchResult[]
      await onSources(results)
      if (showThinking) {
        const snippets = results.slice(0, 3)
          .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
          .join('\n')
        await emitThinking(snippets + '\n\n')
      }
    } else if (part.type === 'reasoning') {
      if (showThinking) await emitThinking(part.textDelta)
    } else if (part.type === 'text-delta') {
      if (extractor) {
        const { text, thinking } = extractor.process(part.textDelta)
        if (thinking && showThinking) await emitThinking(thinking)
        if (text) {
          if (emitTextAsThinking && showThinking) await emitThinking(text)
          await onText(text)
        }
      } else {
        if (emitTextAsThinking && showThinking) await emitThinking(part.textDelta)
        await onText(part.textDelta)
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
