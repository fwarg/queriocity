import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { runResearcher } from '../lib/researcher.ts'
import { runWriter } from '../lib/writer.ts'
import { reformulateSpeed, reformulateLLM } from '../lib/reformulate.ts'
import { cacheKey, getCached, setCached } from '../lib/cache.ts'
import { db, chatSessions, messages } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { webSearchMulti, type SearchResult } from '../lib/searxng.ts'

const chatSchema = z.object({
  sessionId: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  focusMode: z.enum(['speed', 'balanced', 'thorough']).default('balanced'),
})

export const chatRouter = new Hono<AppEnv>()

chatRouter.use('*', authMiddleware)

chatRouter.post('/', zValidator('json', chatSchema), async (c) => {
  const userId = c.get('userId') as string
  const { sessionId, messages: msgs, focusMode } = c.req.valid('json')

  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  const preview = (lastUser?.content ?? '').slice(0, 100).replace(/\n/g, ' ')
  console.log(`\n━━━ [${focusMode}] ${preview}`)

  const ck = cacheKey(lastUser?.content ?? '', focusMode)
  const cached = getCached<string>(ck)
  if (cached) {
    return c.json({ cached: true, content: cached })
  }

  // Reformulate query, then pre-execute for balanced/thorough
  let initialQueries: string[] | undefined
  let initialResults: SearchResult[] | undefined
  try {
    if (focusMode === 'speed') {
      const q = reformulateSpeed(msgs)
      if (q && q !== lastUser?.content) initialQueries = [q]
    } else {
      const queries = await reformulateLLM(msgs, focusMode)
      if (queries.length > 0) {
        initialQueries = queries
        const maxQueries = focusMode === 'thorough' ? 3 : 2
        const countEach = focusMode === 'thorough' ? 10 : 8
        initialResults = await webSearchMulti(queries.slice(0, maxQueries), countEach)
      }
    }
  } catch (e) {
    console.error('[reformulate] error:', e)
  }

  return streamSSE(c, async (stream) => {
    let fullContent = ''
    const sources: unknown[] = []

    if (focusMode === 'thorough') {
      // Phase 1: Research (collect sources, no text to client)
      const researcherResult = runResearcher({ messages: msgs, focusMode, userId, initialQueries, initialResults })
      const allSources: SearchResult[] = [...(initialResults ?? [])]

      for await (const part of researcherResult.fullStream as AsyncIterable<any>) {
        if (part.type === 'tool-result' && part.toolName === 'web_search') {
          allSources.push(...(part.result as SearchResult[]))
        }
      }

      // Dedup by URL
      const seen = new Set<string>()
      const dedupedSources = allSources.filter(s => {
        if (seen.has(s.url)) return false
        seen.add(s.url)
        return true
      })

      sources.push(...dedupedSources)
      await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: dedupedSources }) })

      // Phase 2: Writer pass
      const writerResult = runWriter(dedupedSources, msgs)
      for await (const part of writerResult.fullStream) {
        if (part.type === 'text-delta') {
          fullContent += part.textDelta
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
        }
      }
    } else {
      // Speed / balanced: stream researcher output directly
      if (initialResults?.length) {
        sources.push(...initialResults.map(r => ({ title: r.title, url: r.url })))
        await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: initialResults }) })
      }

      const result = runResearcher({ messages: msgs, focusMode, userId, initialQueries, initialResults })

      for await (const part of result.fullStream as AsyncIterable<any>) {
        if (part.type === 'text-delta') {
          fullContent += part.textDelta
          await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
        } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
          const results = part.result as SearchResult[]
          sources.push(...results.map(r => ({ title: r.title, url: r.url })))
          await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: results }) })
        }
      }
    }

    // Persist to DB
    const sid = sessionId ?? randomUUID()
    await persistMessage(sid, userId, msgs, fullContent, sources)

    setCached(ck, fullContent)
    await stream.writeSSE({ data: JSON.stringify({ type: 'done', sessionId: sid }) })
  })
})

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
