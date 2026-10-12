/** Characterisation of POST /chat per focus mode: the SSE event order the client depends on (resume
 *  replays it verbatim) and what each mode stores. Pins current behaviour ahead of splitting the
 *  handler, against fake model, SearXNG and image servers. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeOpenAI, type ScriptedStep } from '../lib/test-support/fake-openai.ts'
import { startFakeSearxng, signature, type SseEvent } from '../lib/test-support/fake-searxng.ts'
import { envOverride } from '../lib/test-support/env-override.ts'

const { db, users, messages, setAppSetting } = await import('../lib/db.ts')
const { eq } = await import('drizzle-orm')
const { chatRouter } = await import('./chat.ts')
const { signToken, AUTH_COOKIE } = await import('../lib/auth.ts')

const USER = 'modes-user'
const app = new Hono().route('/chat', chatRouter)
let cookie = ''
let restoreEnv: () => void
let searxng: ReturnType<typeof startFakeSearxng>
let fake: ReturnType<typeof startFakeOpenAI> | null = null

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({ id: USER, email: `${USER}@example.com`, name: null, role: 'user', settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now })
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: USER, email: `${USER}@example.com`, role: 'user', tokenVersion: 0 })}`
  // Raw-query pre-search keeps the model calls to the ones each mode makes itself.
  await setAppSetting('query_reformulation', 'false')
  searxng = startFakeSearxng()
  restoreEnv = envOverride({ CHAT_API_KEY: 'test', CHAT_MODEL: 'fake', SEARXNG_URL: searxng.url, SPEJAREN_URL: '', SEARCH_API_PROVIDER: '', RERANK_MODEL: '' })
})

afterEach(() => { fake?.stop(); fake = null })
afterAll(() => { searxng.stop(); restoreEnv() })

/** Points the chat model at a fresh fake serving `script`. */
function useModel(script: ScriptedStep[]) {
  fake = startFakeOpenAI(script)
  process.env.CHAT_BASE_URL = fake.baseURL
  return fake
}

async function chat(sessionId: string, focusMode: string, content: string): Promise<SseEvent[]> {
  const res = await app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ sessionId, focusMode, messages: [{ role: 'user', content }] }),
  })
  const text = await res.text()
  return text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
}

const answerOf = (events: SseEvent[]) => events.filter(e => e.type === 'text').map(e => e.delta).join('')

async function stored(sessionId: string) {
  const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId))
  const answer = rows.find(r => r.role === 'assistant')
  return {
    roles: rows.map(r => r.role),
    content: answer?.content,
    sources: JSON.parse(answer?.sources ?? '[]') as Array<Record<string, unknown>>,
  }
}

describe('flash', () => {
  test('streams the answer and stores it without sources', async () => {
    useModel([{ text: ['Flash ', 'answer.'] }])
    const events = await chat('modes-flash', 'flash', 'What is a bee?')
    expect(signature(events)).toEqual(['session', 'status', 'context', 'text', 'done'])
    expect(answerOf(events)).toBe('Flash answer.')
    expect(await stored('modes-flash')).toEqual({ roles: ['user', 'assistant'], content: 'Flash answer.', sources: [] })
  })
})

describe('balanced', () => {
  test('reports pre-search, streams the answer, and stores sources with snippets', async () => {
    const model = useModel([{ text: ['Bees make honey [1].'] }])
    const events = await chat('modes-balanced', 'balanced', 'What do bees make?')
    expect(signature(events)).toEqual([
      'session', 'step:understand', 'step:search', 'step:results', 'sources', 'context', 'step:reason', 'text', 'done',
    ])
    expect(answerOf(events)).toBe('Bees make honey [1].')
    expect(searxng.queries).toContain('What do bees make?')
    expect(model.callCount).toBe(1)
    const { content, sources } = await stored('modes-balanced')
    expect(content).toBe('Bees make honey [1].')
    expect(sources[0]).toEqual({ title: 'Result 1', url: 'https://site1.example.com/page', content: 'Snippet about result 1.' })
  })

  test('falls back to a no-tool synthesis when the researcher answers with nothing', async () => {
    const model = useModel([{ text: [''] }, { text: ['Synthesised [1].'] }])
    const events = await chat('modes-fallback', 'balanced', 'What do wasps make?')
    expect(signature(events)).toContain('step:write')
    expect(answerOf(events)).toBe('Synthesised [1].')
    expect(model.callCount).toBe(2)
    expect((await stored('modes-fallback')).content).toBe('Synthesised [1].')
  })
})

describe('thorough', () => {
  test('researches silently, then the writer streams the answer over deduped sources', async () => {
    const model = useModel([
      { toolCall: { id: 'c1', name: 'web_search', args: { queries: ['bee biology'] } } },
      { text: ['Notes: bees pollinate.'] },
      { text: ['Bees pollinate [1].'] },
    ])
    const events = await chat('modes-thorough', 'thorough', 'Why do bees matter?')
    expect(signature(events)).toEqual([
      'session', 'step:understand', 'step:search', 'step:results',
      'context', 'step:reason', 'step:search', 'step:results', 'step:reason', 'context',
      'sources', 'step:write', 'text', 'done',
    ])
    // Researcher text is notes for the writer, never shown as the answer.
    expect(answerOf(events)).toBe('Bees pollinate [1].')
    expect(model.callCount).toBe(3)
    const finalSources = events.findLast(e => e.type === 'sources')!.sources as Array<{ url: string }>
    expect(new Set(finalSources.map(s => s.url)).size).toBe(finalSources.length)
    const { content, sources } = await stored('modes-thorough')
    expect(content).toBe('Bees pollinate [1].')
    expect(sources.map(s => s.url)).toEqual(finalSources.map(s => s.url))
    expect(sources[0].content).toBeString()
  })
})

describe('image', () => {
  const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  let imageServer: ReturnType<typeof Bun.serve>
  let storageDir = ''
  let undoImageEnv: () => void

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'modes-images-'))
    imageServer = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ b64_json: PNG_1X1 }] }) })
    undoImageEnv = envOverride({ IMAGE_BASE_URL: `http://localhost:${imageServer.port}`, IMAGE_STORAGE_DIR: storageDir })
  })
  afterAll(async () => { imageServer.stop(true); undoImageEnv(); await rm(storageDir, { recursive: true, force: true }) })

  test('runs the image tool and stores the image as markdown', async () => {
    useModel([
      { toolCall: { id: 'i1', name: 'generate_image', args: { prompt: 'a bee' } } },
      { text: [''] },
    ])
    const events = await chat('modes-image', 'image', 'Draw a bee')
    expect(signature(events)).toEqual(['session', 'context', 'step:image', 'image', 'done'])
    const image = events.find(e => e.type === 'image')!
    expect(image.url).toMatch(/^\/images\/modes-user\/[\w-]+\.png$/)
    expect((await stored('modes-image')).content).toBe(`![a bee](${image.url})`)
  })
})
