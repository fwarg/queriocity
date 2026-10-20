/** Deep-dream re-extraction over long chats.
 *
 *  The bug this guards: each chat was sent to the model whole, so one long enough to exceed the
 *  context window failed the request and with it the space's nightly compaction. A long chat must be
 *  read in pieces that each fit. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import { startFakeOpenAI } from './test-support/fake-openai.ts'
import { envOverride } from './test-support/env-override.ts'

const { db, users, spaces, chatSessions, messages, EMBED_DIMS } = await import('./db.ts')

// Copied, not aliased, so afterAll can restore it: `mock.module` is process-wide (see memory-conflict.test.ts).
const realEmbeddings = { ...(await import('./embeddings.ts')) }
const unit = () => Array(EMBED_DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))
mock.module('./embeddings.ts', () => ({
  embedText: async () => unit(),
  embedTexts: async (texts: string[]) => texts.map(unit),
}))

const CONTEXT_TOKENS = 1000
let server: ReturnType<typeof startFakeOpenAI>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeOpenAI([{ text: ['- Bees prefer warm hives in early spring.'] }])
  restoreEnv = envOverride({
    CHAT_BASE_URL: server.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'fake', CONTEXT_TOKEN_LIMIT: String(CONTEXT_TOKENS),
  })

  const now = new Date()
  await db.insert(users).values({
    id: 'du', email: 'du@example.com', name: null, role: 'user',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  await db.insert(spaces).values({ id: 'ds', name: 'ds', userId: 'du', createdAt: now, updatedAt: now })
  await db.insert(chatSessions).values({ id: 'dchat', title: 'Bees', userId: 'du', spaceId: 'ds', createdAt: now, updatedAt: now })
  const long = Array.from({ length: 120 }, (_, i) => `Hive note ${i} records the temperature.`).join(' ')
  await db.insert(messages).values([
    { id: 'dm1', sessionId: 'dchat', role: 'user', content: long, createdAt: now },
    { id: 'dm2', sessionId: 'dchat', role: 'assistant', content: long, createdAt: now },
  ])
})

afterAll(() => {
  server?.stop()
  restoreEnv?.()
  mock.module('./embeddings.ts', () => realEmbeddings)
})

const { deepDreamSpace } = await import('./memory.ts')
const { contextCharBudget } = await import('./trim-messages.ts')

type WireMessage = { role: string; content: string | Array<{ text?: string }> }
const textOf = (m: WireMessage) => typeof m.content === 'string' ? m.content : m.content.map(p => p.text ?? '').join('')

describe('deepDreamSpace', () => {
  test('reads a chat longer than the context window in pieces that each fit', async () => {
    expect(await deepDreamSpace('ds', 5000)).toBe(true)

    const extractions = (server.requests as Array<{ messages: WireMessage[] }>)
      .filter(r => textOf(r.messages[0]).startsWith('Extract long-term'))
      .map(r => textOf(r.messages[1]))
    expect(extractions.length).toBeGreaterThan(1)
    for (const prompt of extractions) expect(prompt.length).toBeLessThanOrEqual(contextCharBudget(CONTEXT_TOKENS))
  })
})
