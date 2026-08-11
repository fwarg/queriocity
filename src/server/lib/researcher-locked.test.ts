/** Proves a locked space withholds the networked tools, asserted on the request bodies the provider
 *  actually receives.
 *
 *  The wire is the only honest place to check this. A test on internal state would pass just as
 *  happily if the tools were offered and refused inside `execute` — which is a materially weaker
 *  guarantee, because it leaves the refusal to logic that can be wrong, and still tells the model
 *  the capability exists. */

import { describe, test, expect, afterEach } from 'bun:test'
import { startFakeOpenAI } from './test-support/fake-openai.ts'

let fake: ReturnType<typeof startFakeOpenAI> | null = null
let searxng: { url: string; stop: () => void; hits: string[] } | null = null

function startFakeSearxng() {
  const hits: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      hits.push(new URL(req.url).searchParams.get('q') ?? '')
      return Response.json({ results: [{ title: 'r', url: 'https://example.com/1', content: 'one', engine: 'stub' }] })
    },
  })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true), hits }
}

afterEach(() => { fake?.stop(); fake = null; searxng?.stop(); searxng = null })

async function toolNamesOffered(locked: boolean): Promise<string[][]> {
  searxng = startFakeSearxng()
  process.env.SEARXNG_URL = searxng.url
  fake = startFakeOpenAI([{ text: ['An answer from the document.'] }])

  const { createOpenAI } = await import('@ai-sdk/openai')
  const { runResearcher } = await import('./researcher.ts')
  const model = createOpenAI({ baseURL: fake.baseURL, apiKey: 't' }).chat('m')

  const res = await runResearcher({
    messages: [{ role: 'user', content: 'what does the attached contract say about termination?' }],
    focusMode: 'balanced', userId: 'u1', model, spaceId: 'space-1', hasFiles: true, locked,
  })
  for await (const part of res.stream) void part

  return fake.requests.map(r => {
    const tools = (r as { tools?: Array<{ function?: { name?: string } }> } | null)?.tools
    return (tools ?? []).map(t => t.function?.name ?? '')
  })
}

describe('locked space', () => {
  test('offers neither web_search nor fetch_url on any step', async () => {
    for (const names of await toolNamesOffered(true)) {
      expect(names).not.toContain('web_search')
      expect(names).not.toContain('fetch_url')
    }
  })

  test('still offers the local tools, which are the point of the mode', async () => {
    const perStep = await toolNamesOffered(true)
    expect(perStep.flat()).toContain('uploads_search')
    expect(perStep.flat()).toContain('save_to_memory')
  })

  test('offers both networked tools when the space is not locked — guards the test itself', async () => {
    const perStep = await toolNamesOffered(false)
    expect(perStep.flat()).toContain('web_search')
    expect(perStep.flat()).toContain('fetch_url')
  })

  test('overrides the mode prompt that tells the model to search first', async () => {
    searxng = startFakeSearxng()
    process.env.SEARXNG_URL = searxng.url
    fake = startFakeOpenAI([{ text: ['Answer.'] }])
    const { createOpenAI } = await import('@ai-sdk/openai')
    const { runResearcher } = await import('./researcher.ts')
    const model = createOpenAI({ baseURL: fake.baseURL, apiKey: 't' }).chat('m')
    const res = await runResearcher({
      messages: [{ role: 'user', content: 'q' }],
      focusMode: 'balanced', userId: 'u1', model, spaceId: 'space-1', locked: true,
    })
    for await (const part of res.stream) void part

    const system = ((fake.requests[0] as { messages?: Array<{ role: string; content: string }> } | null)
      ?.messages ?? []).find(m => m.role === 'system')?.content ?? ''
    expect(system).toContain('This space is locked')
    expect(system).toContain('Ignore any instruction above to search')
  })
})
