/** Proves a locked space withholds the networked tools, asserted on the request bodies the provider
 *  actually receives.
 *
 *  The wire is the only honest place to check this. A test on internal state would pass just as
 *  happily if the tools were offered and refused inside `execute` — which is a materially weaker
 *  guarantee, because it leaves the refusal to logic that can be wrong, and still tells the model
 *  the capability exists. */

import { describe, test, expect, afterEach } from 'bun:test'
import { startFakeOpenAI, type ScriptedStep } from './test-support/fake-openai.ts'
import { envOverride } from './test-support/env-override.ts'

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

describe('locked space with SPEJAREN_TRUSTED', () => {
  let spejaren: { url: string; stop: () => void; hits: string[] } | null = null
  let undoEnv: (() => void) | null = null
  afterEach(() => { spejaren?.stop(); spejaren = null; undoEnv?.(); undoEnv = null })

  function startFakeSpejaren() {
    const hits: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        hits.push(new URL(req.url).searchParams.get('q') ?? '')
        return Response.json({ results: [{ title: 's', url: 'https://x.se/1', content: 'passage', domain: 'x.se' }] })
      },
    })
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true), hits }
  }

  async function runLocked(trusted: string, script: ScriptedStep[]) {
    searxng = startFakeSearxng()
    spejaren = startFakeSpejaren()
    undoEnv = envOverride({ SEARXNG_URL: searxng.url, SPEJAREN_URL: spejaren.url, SPEJAREN_TRUSTED: trusted })
    fake = startFakeOpenAI(script)

    const { createOpenAI } = await import('@ai-sdk/openai')
    const { runResearcher } = await import('./researcher.ts')
    const model = createOpenAI({ baseURL: fake.baseURL, apiKey: 't' }).chat('m')
    const res = await runResearcher({
      messages: [{ role: 'user', content: 'what do small sites say about bee keeping?' }],
      focusMode: 'balanced', userId: 'u1', model, spaceId: 'space-1', locked: true,
    })
    for await (const part of res.stream) void part

    type Req = { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string; content: string }> } | null
    const requests = fake.requests as Req[]
    return {
      tools: requests.flatMap(r => (r?.tools ?? []).map(t => t.function?.name ?? '')),
      system: (requests[0]?.messages ?? []).find(m => m.role === 'system')?.content ?? '',
    }
  }

  test('offers web_search backed by spejaren alone, and still no fetch_url', async () => {
    const { tools, system } = await runLocked('true', [
      { toolCall: { id: 'c1', name: 'web_search', args: { queries: ['bee keeping'] } } },
      { text: ['An answer.'] },
    ])
    expect(tools).toContain('web_search')
    expect(tools).not.toContain('fetch_url')
    expect(spejaren?.hits).toEqual(['bee keeping'])
    expect(searxng?.hits).toEqual([])
    expect(system).toContain('searches only a trusted, self-hosted index')
  })

  test('offers no search unless SPEJAREN_TRUSTED is true', async () => {
    const { tools, system } = await runLocked('yes', [{ text: ['An answer.'] }])
    expect(tools).not.toContain('web_search')
    expect(system).toContain('there is no web search')
  })
})
