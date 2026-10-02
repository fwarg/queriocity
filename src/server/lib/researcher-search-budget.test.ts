/** A limited search budget is told to the model up front and in every web_search result, and
 *  queries beyond it are not run — asserted on the wire, against fake model and SearXNG servers. */

import { describe, test, expect, afterEach } from 'bun:test'
import { startFakeOpenAI } from './test-support/fake-openai.ts'
import { envOverride } from './test-support/env-override.ts'
import type { SearchBudget } from './search/index.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const undo of cleanups.splice(0).reverse()) undo() })

type Req = { messages?: Array<{ role: string; content: unknown }> } | null

async function research(searchBudget: SearchBudget) {
  const hits: string[] = []
  const searxng = Bun.serve({
    port: 0,
    fetch: (req) => {
      hits.push(new URL(req.url).searchParams.get('q') ?? '')
      return Response.json({ results: [{ title: 'r', url: `https://example.com/${hits.length}`, content: 'one', engine: 'stub' }] })
    },
  })
  cleanups.push(() => searxng.stop(true))
  cleanups.push(envOverride({ SEARXNG_URL: `http://localhost:${searxng.port}`, SPEJAREN_URL: '', SEARCH_API_PROVIDER: '' }))
  const fake = startFakeOpenAI([
    { toolCall: { id: 'c1', name: 'web_search', args: { queries: ['bee keeping history', 'honey production sweden'] } } },
    { text: ['An answer.'] },
  ])
  cleanups.push(() => fake.stop())

  const { createOpenAI } = await import('@ai-sdk/openai')
  const { runResearcher } = await import('./researcher.ts')
  const model = createOpenAI({ baseURL: fake.baseURL, apiKey: 't' }).chat('m')
  const res = await runResearcher({ messages: [{ role: 'user', content: 'tell me about bees' }], focusMode: 'balanced', userId: 'u1', model, searchBudget })
  for await (const part of res.stream) void part

  const requests = fake.requests as Req[]
  const system = String(requests[0]?.messages?.find(m => m.role === 'system')?.content ?? '')
  const toolResult = JSON.stringify(requests[1]?.messages?.filter(m => m.role === 'tool') ?? [])
  return { hits, system, toolResult }
}

describe('limited search budget', () => {
  test('is stated in the system prompt and counted down in the tool result', async () => {
    const { hits, system, toolResult } = await research({ fallbackRemaining: 0, queriesRemaining: 3 })
    expect(system).toContain('you can run 3 more search queries')
    expect(hits).toHaveLength(2)
    expect(toolResult).toMatch(/searchesLeft\\?":1/)
  })

  test('runs only the queries the budget allows, and says so', async () => {
    const { hits, toolResult } = await research({ fallbackRemaining: 0, queriesRemaining: 1 })
    expect(hits).toHaveLength(1)
    expect(toolResult).toContain('1 of your queries were not run')
  })

  test('leaves prompt and result shape alone when unlimited', async () => {
    const { system, toolResult } = await research({ fallbackRemaining: 0, queriesRemaining: Infinity })
    expect(system).not.toContain('Search budget')
    expect(toolResult).not.toContain('searchesLeft')
  })
})
