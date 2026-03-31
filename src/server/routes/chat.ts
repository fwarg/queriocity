import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { streamText } from 'ai'
import { runResearcher } from '../lib/researcher.ts'
import { runWriter } from '../lib/writer.ts'
import { reformulateSpeed, reformulateLLM } from '../lib/reformulate.ts'
import { cacheKey, getCached, setCached } from '../lib/cache.ts'
import { db, chatSessions, messages, users, uploadedFiles } from '../lib/db.ts'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { webSearch, webSearchMulti, type SearchResult } from '../lib/searxng.ts'
import { getFlashModel, getChatModel, getThinkingModelOrFallback } from '../lib/llm.ts'
import { ThinkExtractor } from '../lib/think-extractor.ts'
import { rerank, rerankEnabled } from '../lib/reranker.ts'

const FLASH_SYSTEM = `Answer in at most 5 sentences using only your training knowledge. Be direct and factual.
Do not search the web. If you cannot answer confidently, say so briefly.
Always respond in the same language the user used.`

const chatSchema = z.object({
  sessionId: z.string().optional(),
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
  const { sessionId, messages: msgs, focusMode } = c.req.valid('json')

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
    const userRow = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get()
    const customPrompt: string | undefined = userRow ? (JSON.parse(userRow.settings).customPrompt ?? undefined) : undefined
    const sid = sessionId ?? randomUUID()
    const t0 = Date.now()
    let fullContent = ''
    return streamSSE(c, async (stream) => {
      const result = streamText({
        model: getFlashModel(),
        abortSignal,
        system: FLASH_SYSTEM + (customPrompt ? `\n\nAdditional instructions:\n${customPrompt}` : ''),
        messages: msgs,
        maxTokens: 200,
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullContent += part.textDelta
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
        }
      }
      console.log(`  [flash] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)
      setCached(ck, fullContent)
      await persistMessage(sid, userId, msgs, fullContent, [])
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, elapsedMs: Date.now() - t0 }) })
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

  // Fetch user settings + file count + reformulate/pre-search in parallel
  const [userRow, fileCountRow, { initialQueries, initialResults }] = await Promise.all([
    db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
    db.select({ count: sql<number>`count(*)` }).from(uploadedFiles).where(eq(uploadedFiles.userId, userId)).get(),
    runReformulateAndPreSearch(msgsForReformulate, focusMode as 'fast' | 'balanced' | 'thorough', hasAttachment),
  ])
  const parsedSettings = userRow ? JSON.parse(userRow.settings) : {}
  const customPrompt: string | undefined = parsedSettings.customPrompt ?? undefined
  const showThinkingSettings = parsedSettings.showThinking ?? { balanced: false, thorough: false }
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
      const researcherResult = runResearcher({ messages: msgs, focusMode, userId, model: researchModel, abortSignal, initialQueries, initialResults, customPrompt, hasFiles })
      const allSources: SearchResult[] = [...(initialResults ?? [])]
      let researcherNotes = ''
      const thoroughExtractor = useThinking ? new ThinkExtractor() : null

      const keepalive = setInterval(() => {
        stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }).catch(() => {})
      }, 15000)
      try {
      for await (const part of researcherResult.fullStream as AsyncIterable<any>) {
        if (part.type === 'tool-call' && part.toolName === 'web_search') {
          await emitSearchStatus(part.args)
          if (showThinking) {
            const queries: string[] = part.args.queries ?? (part.args.query ? [part.args.query] : [])
            await stream.writeSSE({ data: JSON.stringify({ type: 'thinking',
              delta: `🔍 Searching: ${queries.map(q => `"${q}"`).join(', ')}\n` }) })
          }
        } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
          allSources.push(...(part.result as SearchResult[]))
          if (showThinking) {
            const snippets = (part.result as SearchResult[]).slice(0, 3)
              .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
              .join('\n')
            await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: snippets + '\n\n' }) })
          }
        } else if (part.type === 'reasoning') {
          if (showThinking) await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: part.textDelta }) })
        } else if (part.type === 'text-delta') {
          if (thoroughExtractor) {
            const { text, thinking } = thoroughExtractor.process(part.textDelta)
            if (thinking && showThinking) await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: thinking }) })
            if (text) {
              researcherNotes += text
              if (showThinking) await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: text }) })
            }
          } else {
            researcherNotes += part.textDelta
            if (showThinking) {
              await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: part.textDelta }) })
            }
          }
        } else if (part.type === 'error') {
          console.error('  [researcher] stream error:', part.error)
        }
      }
      } finally {
        clearInterval(keepalive)
      }
      if (thoroughExtractor) {
        const { text, thinking } = thoroughExtractor.flush()
        if (thinking) await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: thinking }) })
        if (text) {
          researcherNotes += text
          await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: text }) })
        }
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
      const writerResult = runWriter(finalSources, msgs, researcherNotes.slice(0, 2000), abortSignal)
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

      const result = runResearcher({ messages: msgs, focusMode, userId, model: getChatModel(), abortSignal, initialQueries, initialResults, customPrompt, hasFiles })
      const extractor = showThinking ? new ThinkExtractor() : null

      for await (const part of result.fullStream as AsyncIterable<any>) {
        if (part.type === 'tool-call' && part.toolName === 'web_search') {
          await emitSearchStatus(part.args)
          if (showThinking) {
            const queries: string[] = part.args.queries ?? (part.args.query ? [part.args.query] : [])
            await stream.writeSSE({ data: JSON.stringify({ type: 'thinking',
              delta: `🔍 Searching: ${queries.map(q => `"${q}"`).join(', ')}\n` }) })
          }
        } else if (part.type === 'text-delta') {
          if (extractor) {
            const { text, thinking } = extractor.process(part.textDelta)
            if (thinking) await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: thinking }) })
            if (text) {
              fullContent += text
              await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: text }) })
            }
          } else {
            fullContent += part.textDelta
            await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
          }
        } else if (part.type === 'reasoning') {
          if (showThinking) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: part.textDelta }) })
          }
        } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
          const results = part.result as SearchResult[]
          sources.push(...results.map(r => ({ title: r.title, url: r.url })))
          await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: results }) })
          if (showThinking) {
            const snippets = results.slice(0, 3)
              .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
              .join('\n')
            await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: snippets + '\n\n' }) })
          }
        }
      }

      if (extractor) {
        const { text, thinking } = extractor.flush()
        if (thinking) await stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta: thinking }) })
        if (text) {
          fullContent += text
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: text }) })
        }
      }
    }

    console.log(`  [${focusMode}] done in ${Date.now() - t0}ms, ${fullContent.length} chars`)

    // Persist to DB
    const sid = sessionId ?? randomUUID()
    await persistMessage(sid, userId, msgs, fullContent, sources)

    setCached(ck, fullContent)
    await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid, elapsedMs: Date.now() - t0 }) })
  })
})

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
) {
  const now = new Date()
  const existing = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get()
  if (!existing) {
    await db.insert(chatSessions).values({
      id: sessionId,
      title: msgs.find(m => m.role === 'user')?.content.slice(0, 60) ?? 'Chat',
      createdAt: now,
      updatedAt: now,
      userId,
    })
  }

  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  if (lastUser) {
    await db.insert(messages).values({
      id: randomUUID(),
      sessionId,
      role: 'user',
      content: lastUser.content,
      createdAt: now,
    })
  }

  await db.insert(messages).values({
    id: randomUUID(),
    sessionId,
    role: 'assistant',
    content: assistantContent,
    sources: JSON.stringify(sources),
    createdAt: now,
  })
}
