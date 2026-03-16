import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { runResearcher } from '../lib/researcher.ts'
import { cacheKey, getCached, setCached } from '../lib/cache.ts'
import { db, chatSessions, messages } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../middleware/auth.ts'

const chatSchema = z.object({
  sessionId: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  focusMode: z.enum(['speed', 'balanced', 'thorough']).default('balanced'),
})

export const chatRouter = new Hono()

chatRouter.use('*', authMiddleware)

chatRouter.post('/', zValidator('json', chatSchema), async (c) => {
  const userId = c.get('userId') as string
  const { sessionId, messages: msgs, focusMode } = c.req.valid('json')

  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  const ck = cacheKey(lastUser?.content ?? '', focusMode)
  const cached = getCached<string>(ck)
  if (cached) {
    return c.json({ cached: true, content: cached })
  }

  return streamSSE(c, async (stream) => {
    let fullContent = ''
    const sources: unknown[] = []

    const result = runResearcher({ messages: msgs, focusMode, userId })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        fullContent += part.textDelta
        await stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: part.textDelta }) })
      } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
        const results = part.result as Array<{ title: string; url: string }>
        sources.push(...results.map(r => ({ title: r.title, url: r.url })))
        await stream.writeSSE({ data: JSON.stringify({ type: 'sources', sources: results }) })
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
