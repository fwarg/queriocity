/** Characterisation of the monitor executor per focus mode: what a run stores, against fake model
 *  and SearXNG servers. Pins current behaviour ahead of moving it onto the shared turn runner. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { startFakeOpenAI, type ScriptedStep } from './test-support/fake-openai.ts'
import { startFakeSearxng } from './test-support/fake-searxng.ts'
import { envOverride } from './test-support/env-override.ts'
import type { SearchResult } from './search/index.ts'
import type { MonitorMode } from './chat-executor.ts'

const { db, users, messages, chatSessions, setAppSetting } = await import('./db.ts')
const { eq } = await import('drizzle-orm')
const { executeChatAndSave } = await import('./chat-executor.ts')

const USER = 'exec-user'
let restoreEnv: () => void
let searxng: ReturnType<typeof startFakeSearxng>
let fake: ReturnType<typeof startFakeOpenAI> | null = null

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({ id: USER, email: `${USER}@example.com`, name: null, role: 'user', settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now })
  await setAppSetting('query_reformulation', 'false')
  searxng = startFakeSearxng()
  restoreEnv = envOverride({ CHAT_API_KEY: 'test', CHAT_MODEL: 'fake', SEARXNG_URL: searxng.url, SPEJAREN_URL: '', SEARCH_API_PROVIDER: '', RERANK_MODEL: '' })
})

afterEach(() => { fake?.stop(); fake = null })
afterAll(() => { searxng.stop(); restoreEnv() })

function useModel(script: ScriptedStep[]) {
  fake = startFakeOpenAI(script)
  process.env.CHAT_BASE_URL = fake.baseURL
  return fake
}

async function run(sessionId: string, focusMode: MonitorMode, promptText: string, feedItems?: SearchResult[]) {
  await executeChatAndSave({ sessionId, userId: USER, title: 'Monitor', promptText, focusMode, feedItems })
  const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId))
  const answer = rows.find(r => r.role === 'assistant')
  return {
    roles: rows.map(r => r.role),
    content: answer?.content,
    sources: JSON.parse(answer?.sources ?? '[]') as Array<Record<string, unknown>>,
  }
}

describe('monitor executor', () => {
  test('balanced pre-searches and stores the answer with its sources and snippets', async () => {
    const model = useModel([{ text: ['<think>hm</think>Bees make ', 'honey [1].'] }])
    const { roles, content, sources } = await run('exec-balanced', 'balanced', 'What do bees make?')
    expect(roles).toEqual(['user', 'assistant'])
    expect(content).toBe('Bees make honey [1].')
    const session = await db.select().from(chatSessions).where(eq(chatSessions.id, 'exec-balanced')).get()
    expect(session?.title).toBe('Monitor')
    expect(searxng.queries).toContain('What do bees make?')
    expect(model.callCount).toBe(1)
    expect(sources[0]).toEqual({ title: 'Result 1', url: 'https://site1.example.com/page', content: 'Snippet about result 1.' })
  })

  test('balanced falls back to synthesis when the researcher answers with nothing', async () => {
    const model = useModel([{ text: [''] }, { text: ['Synthesised [1].'] }])
    expect((await run('exec-fallback', 'balanced', 'What do wasps make?')).content).toBe('Synthesised [1].')
    expect(model.callCount).toBe(2)
  })

  test('feed items replace the web pre-search', async () => {
    useModel([{ text: ['From the feed [1].'] }])
    const before = searxng.queries.length
    const feed = [{ title: 'Feed item', url: 'https://feed.example.com/a', content: 'News.' }]
    const { content, sources } = await run('exec-feed', 'balanced', 'Summarise the news', feed)
    expect(content).toBe('From the feed [1].')
    expect(searxng.queries.length).toBe(before)
    expect(sources[0]).toEqual({ title: 'Feed item', url: 'https://feed.example.com/a', content: 'News.' })
  })

  test('thorough researches, then stores the writer\'s answer over deduped sources', async () => {
    const model = useModel([
      { toolCall: { id: 'c1', name: 'web_search', args: { queries: ['bee biology'] } } },
      { text: ['Notes: bees pollinate.'] },
      { text: ['Bees pollinate [1].'] },
    ])
    const { content, sources } = await run('exec-thorough', 'thorough', 'Why do bees matter?')
    expect(content).toBe('Bees pollinate [1].')
    expect(model.callCount).toBe(3)
    // Pre-search and the researcher's search both return the same three pages.
    expect(sources.map(s => s.url)).toEqual(['https://site1.example.com/page', 'https://site2.example.com/page', 'https://site3.example.com/page'])
    expect(sources[0].content).toBe('Snippet about result 1.')
    const writerPrompt = JSON.stringify(model.requests[2])
    expect(writerPrompt).toContain('Notes: bees pollinate.')
  })

  // The test server is a private address, so the guard refuses it; the refusal reaching the
  // researcher shows the link was fetched before it ran.
  test('fetches a link in the prompt before researching', async () => {
    const model = useModel([{ text: ['Read it [1].'] }])
    await run('exec-url', 'balanced', 'Summarise http://localhost:9/page please')
    expect(JSON.stringify(model.requests[0])).toContain('Error fetching http://localhost:9/page')
  })

  test('saves a failure notice rather than an empty answer', async () => {
    // The researcher and the synthesis fallback both come back empty.
    useModel([{ text: [''] }])
    const { content } = await run('exec-empty', 'balanced', 'Anything?')
    const { EMPTY_ANSWER_MESSAGE } = await import('./answer.ts')
    expect(content).toBe(EMPTY_ANSWER_MESSAGE)
  })
})
