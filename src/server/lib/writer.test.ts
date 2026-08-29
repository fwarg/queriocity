/** The writer produces the entire visible answer in thorough mode, so what reaches its prompt
 *  is what the user gets. These assert on the request the writer builds, not on model output. */

// Must precede the ./writer.ts import: it reaches lib/llm.ts, which builds providers at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, afterEach } from 'bun:test'
import { startFakeOpenAI } from './test-support/fake-openai.ts'
import { runWriter } from './writer.ts'
import type { SearchResult } from './searxng.ts'

let fake: ReturnType<typeof startFakeOpenAI> | null = null
const originalBaseUrl = process.env.CHAT_BASE_URL
afterEach(() => {
  fake?.stop()
  fake = null
  // Restore: CHAT_BASE_URL is process-wide and bun test runs every file in one process.
  if (originalBaseUrl === undefined) delete process.env.CHAT_BASE_URL
  else process.env.CHAT_BASE_URL = originalBaseUrl
})

const sources = (n: number, contentChars = 40): SearchResult[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `Source ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    content: `s${i + 1}-`.padEnd(contentChars, 'x'),
  }))

/** Runs the writer against the fake server and returns the request body it sent. */
async function captureRequest(...args: Parameters<typeof runWriter>) {
  fake = startFakeOpenAI([{ text: ['ok'] }])
  process.env.CHAT_BASE_URL = fake.baseURL
  const result = runWriter(...args)
  await result.consumeStream()
  return fake.requests[0] as { messages: Array<{ role: string; content: string }> }
}

const systemOf = (req: { messages: Array<{ role: string; content: string }> }) =>
  req.messages.find(m => m.role === 'system')?.content ?? ''
const userOf = (req: { messages: Array<{ role: string; content: string }> }) =>
  req.messages.find(m => m.role === 'user')?.content ?? ''

const QUESTION = [{ role: 'user' as const, content: 'What happened?' }]

describe('runWriter', () => {
  // The bug: the researcher received these and the writer did not, so a custom prompt was
  // honoured in flash and balanced but silently dropped in thorough.
  test('carries the custom prompt into the system prompt', async () => {
    const req = await captureRequest(sources(2), QUESTION, '', undefined, { customPrompt: 'Always answer in Swedish.' })
    expect(systemOf(req)).toContain('Always answer in Swedish.')
  })

  test('carries the memory block into the system prompt', async () => {
    const req = await captureRequest(sources(2), QUESTION, '', undefined, { memoryBlock: 'The user works in embedded systems.' })
    expect(systemOf(req)).toContain('The user works in embedded systems.')
  })

  test('omits both cleanly when neither is set', async () => {
    const req = await captureRequest(sources(2), QUESTION)
    expect(systemOf(req)).not.toContain('Additional instructions')
  })

  // The researcher's [N] refer to its own running index; the writer renumbers from 1 over the
  // deduped and reranked array, so a copied [7] would point at a different source.
  test('strips stale citations from the researcher notes', async () => {
    const req = await captureRequest(sources(2), QUESTION, 'Source [7] confirms the closure [12].')
    const user = userOf(req)
    expect(user).toContain('Background context')
    expect(user).not.toContain('[7]')
    expect(user).not.toContain('[12]')
    expect(user).toContain('Source  confirms the closure')
  })

  test('numbers sources from 1 so citations resolve positionally', async () => {
    const user = userOf(await captureRequest(sources(3), QUESTION))
    expect(user).toContain('<result index=1')
    expect(user).toContain('<result index=3')
    expect(user).not.toContain('<result index=0')
  })

  test('keeps every source when they fit the budget', async () => {
    const user = userOf(await captureRequest(sources(3), QUESTION))
    expect(user.match(/<result /g)).toHaveLength(3)
  })

  // Previously the writer inlined every source at full length with no cap, so a long thorough
  // run could overflow its context with no error anywhere.
  test('drops the weakest sources rather than overflowing the context', async () => {
    const originalCtx = process.env.CONTEXT_TOKEN_LIMIT
    process.env.CONTEXT_TOKEN_LIMIT = '1000'   // ~3200 chars of budget
    try {
      const user = userOf(await captureRequest(sources(40, 2000), QUESTION))
      const kept = user.match(/<result /g)?.length ?? 0
      expect(kept).toBeGreaterThan(0)
      expect(kept).toBeLessThan(40)
      // Sources arrive best-first from the reranker, so what survives is the top of the list.
      expect(user).toContain('Source 1')
    } finally {
      if (originalCtx === undefined) delete process.env.CONTEXT_TOKEN_LIMIT
      else process.env.CONTEXT_TOKEN_LIMIT = originalCtx
    }
  })
})
