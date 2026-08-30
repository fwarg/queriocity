/** A fetched page — one the caller prefetched from the user's message, or one the fetch_url tool
 *  read mid-run — has to reach the model as a *numbered* result, or the model cites it as
 *  `[fetch_url]` (a token nothing renders as a link) and it never appears in the reference list.
 *
 *  Asserted on two surfaces: the `onSource` callback the route wires to the client's source list,
 *  and the tool-result message the model is actually handed on the next step. */

import './test-support/test-env.ts'
import { describe, test, expect, afterEach } from 'bun:test'
import { startFakeOpenAI } from './test-support/fake-openai.ts'
import type { SearchResult } from './searxng.ts'

let fake: ReturnType<typeof startFakeOpenAI> | null = null
let searxng: { url: string; stop: () => void } | null = null

function startFakeSearxng() {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ results: [] }),
  })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

afterEach(() => { fake?.stop(); fake = null; searxng?.stop(); searxng = null })

async function run(opts: {
  prefetchedUrls: Array<{ url: string; content: string }>
  initialQueries?: string[]
  initialResults?: SearchResult[]
}) {
  searxng = startFakeSearxng()
  process.env.SEARXNG_URL = searxng.url
  fake = startFakeOpenAI([{ text: ['The page says X [1].'] }])

  const { createOpenAI } = await import('@ai-sdk/openai')
  const { runResearcher } = await import('./researcher.ts')
  const model = createOpenAI({ baseURL: fake.baseURL, apiKey: 't' }).chat('m')

  const sources: Array<SearchResult & { index: number }> = []
  const res = await runResearcher({
    messages: [{ role: 'user', content: 'is the blog still active?' }],
    focusMode: 'balanced', userId: 'u1', model, maxStepsOverride: 2,
    onSource: (s) => { sources.push(s) },
    ...opts,
  })
  for await (const part of res.stream) void part

  const last = fake.requests.at(-1) as { messages?: Array<{ role: string; content: unknown }> } | null
  const toolWire = (last?.messages ?? []).filter(m => m.role === 'tool').map(m => String(m.content)).join('\n')
  return { sources, toolWire }
}

describe('fetched pages as numbered sources', () => {
  test('a prefetched URL is surfaced as source [1] and handed to the model with that number', async () => {
    const { sources, toolWire } = await run({
      prefetchedUrls: [{ url: 'https://example.com/blog', content: 'PAGE BODY TEXT' }],
    })

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      index: 1,
      url: 'https://example.com/blog',
      title: 'example.com/blog',
      content: 'PAGE BODY TEXT',
    })
    // The model must see the number alongside the content, not a bare string.
    expect(toolWire).toContain('"index":1')
    expect(toolWire).toContain('example.com/blog')
  })

  test('two prefetched URLs get consecutive numbers', async () => {
    const { sources } = await run({
      prefetchedUrls: [
        { url: 'https://a.example/x', content: 'A' },
        { url: 'https://b.example/y', content: 'B' },
      ],
    })
    expect(sources.map(s => s.index)).toEqual([1, 2])
    expect(sources.map(s => s.url)).toEqual(['https://a.example/x', 'https://b.example/y'])
  })

  test('a prefetched URL already present as a search result reuses its number, not a second entry', async () => {
    const { sources } = await run({
      initialQueries: ['blog activity'],
      initialResults: [
        { title: 'hit a', url: 'https://other.example/1', content: 'one' },
        { title: 'hit b', url: 'https://example.com/blog', content: 'two' },
      ],
      prefetchedUrls: [{ url: 'https://example.com/blog', content: 'FULL PAGE' }],
    })
    // Search results took indices 1 and 2; the prefetch matches #2, so no new source is emitted.
    expect(sources).toHaveLength(0)
  })
})
