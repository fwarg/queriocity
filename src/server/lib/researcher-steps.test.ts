/** Verifies the balanced-mode writing-step reserve at the wire level.
 *
 *  Balanced reserves the final step for prose, because a tool result arriving on the last
 *  generation can never be used — the turn would end on finishReason=tool-calls with an empty
 *  answer. This used to be enforced inside each tool's execute(), which cost *two* steps: the
 *  refused call still consumed one. `prepareStep` withholds the tools instead, so it costs one,
 *  giving balanced an extra round of searching.
 *
 *  Asserted against the request bodies the provider actually sends, not internal state, since
 *  the whole point is what the model is offered. */

import { describe, test, expect, afterEach } from 'bun:test'
import { startFakeOpenAI } from './test-support/fake-openai.ts'

// A stub SearXNG so web_search resolves without touching the network.
function startFakeSearxng() {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      results: [
        { title: 'r1', url: 'https://example.com/1', content: 'one', engine: 'stub' },
        { title: 'r2', url: 'https://example.org/2', content: 'two', engine: 'stub' },
      ],
    }),
  })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

let fake: ReturnType<typeof startFakeOpenAI> | null = null
let searxng: ReturnType<typeof startFakeSearxng> | null = null
afterEach(() => { fake?.stop(); fake = null; searxng?.stop(); searxng = null })

const searchStep = (n: number) => ({ toolCall: { id: `c${n}`, name: 'web_search', args: { queries: [`q${n}`] } } })

/** Runs the researcher against a model that always wants to search, and reports, per request,
 *  whether any tools were offered. */
async function toolsOfferedPerStep(focusMode: 'balanced' | 'thorough', maxSteps?: number) {
  // Enough scripted steps to exhaust any plausible budget when the default is under test.
  const scripted = maxSteps ?? 8
  searxng = startFakeSearxng()
  process.env.SEARXNG_URL = searxng.url
  // Enough scripted search steps to exhaust the budget, then prose.
  fake = startFakeOpenAI([...Array.from({ length: scripted - 1 }, (_, i) => searchStep(i)), { text: ['Final answer.'] }])

  const { createOpenAI } = await import('@ai-sdk/openai')
  const { runResearcher } = await import('./researcher.ts')
  const model = createOpenAI({ baseURL: fake.baseURL, apiKey: 't' }).chat('m')

  const res = await runResearcher({
    messages: [{ role: 'user', content: 'a question' }],
    focusMode, userId: 'u1', model, ...(maxSteps ? { maxStepsOverride: maxSteps } : {}),
  })
  // Drain: the steps only advance as the stream is consumed.
  for await (const part of res.stream) void part

  return fake.requests.map(r => {
    const tools = (r as { tools?: unknown[] } | null)?.tools
    return Array.isArray(tools) && tools.length > 0
  })
}

describe('balanced writing-step reserve', () => {
  test('offers tools on every step but the last', async () => {
    const offered = await toolsOfferedPerStep('balanced', 4)

    expect(offered).toHaveLength(4)
    // Three tool rounds — under the old execute()-level gate this was two, because the
    // refused call burned a step of its own.
    expect(offered.slice(0, 3)).toEqual([true, true, true])
    expect(offered[3]).toBe(false)
  })

  test('reserves exactly one step, whatever the budget', async () => {
    const offered = await toolsOfferedPerStep('balanced', 3)
    expect(offered).toEqual([true, true, false])
  })

  test('the shipped balanced budget gives two tool rounds', async () => {
    // Pins MODE_CONFIG.balanced, deliberately set to 3 so the reserve makes balanced cheaper
    // than thorough rather than widening its budget. Changing it should be a conscious edit.
    const offered = await toolsOfferedPerStep('balanced')
    expect(offered).toEqual([true, true, false])
  })

  test('thorough is exempt — its writer pass supplies the prose', async () => {
    const offered = await toolsOfferedPerStep('thorough', 3)
    expect(offered.every(Boolean)).toBe(true)
  })
})
