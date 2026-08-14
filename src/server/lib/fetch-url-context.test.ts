/** The per-URL context cap is the only thing standing between a 100k-char scrape and the prompt.
 *
 *  It is now an admin setting, so the value the caller passes has to win over the env default —
 *  a silent fallback to the default would look identical in the UI and be invisible in the log. */

import './test-support/test-env.ts'
import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { startFakeOpenAI } from './test-support/fake-openai.ts'

// Copied, not aliased, so afterAll can put it back: `mock.module` is process-wide and outlives this
// file, so a mock left behind is inherited by every test file that runs after it — and it mutates
// the live namespace object in place, so holding the namespace itself would hand back the mock.
const realLlm = { ...(await import('./llm.ts')) }
const { processUrlsForContext, MIN_URL_CONTEXT_CHARS, DEFAULT_MAX_URL_CONTEXT_CHARS, worthSummarizing, describeOutcome } =
  await import('./fetch-url.ts')

const page = (chars: number) => 'x'.repeat(chars)
const urls = (n: number, chars: number) =>
  Array.from({ length: n }, (_, i) => ({ url: `https://e${i}.example/a`, content: page(chars) }))

// Large enough that the per-URL share never binds; the cap is what we are measuring.
const AMPLE_BUDGET = 10_000_000

describe('processUrlsForContext', () => {
  test('truncates to the cap the caller passes, not the env default', async () => {
    const [out] = await processUrlsForContext(urls(1, 90_000), AMPLE_BUDGET, false, 12_000)
    // Truncation appends a marker, so the content is the cap plus that note.
    expect(out.content.length).toBeGreaterThan(12_000)
    expect(out.content.length).toBeLessThan(12_200)
    expect(out.content).toEndWith('[content truncated to fit context]')
  })

  test('falls back to the env default when no cap is given', async () => {
    const [out] = await processUrlsForContext(urls(1, 90_000), AMPLE_BUDGET, false)
    expect(out.content.length).toBeGreaterThan(DEFAULT_MAX_URL_CONTEXT_CHARS)
    expect(out.content.length).toBeLessThan(DEFAULT_MAX_URL_CONTEXT_CHARS + 200)
  })

  test('a tight budget splits below the cap, but never below the floor', async () => {
    const [a] = await processUrlsForContext(urls(2, 90_000), 40_000, false, 40_000)
    expect(a.content.length).toBeLessThan(20_200)   // 40k budget over two URLs

    const [b] = await processUrlsForContext(urls(2, 90_000), 1_000, false, 40_000)
    expect(b.content.length).toBeGreaterThan(MIN_URL_CONTEXT_CHARS)
  })

  test('content already under the cap is passed through untouched', async () => {
    const [out] = await processUrlsForContext(urls(1, 500), AMPLE_BUDGET, false, 12_000)
    expect(out.content).toBe(page(500))
  })
})

describe('outcome reporting', () => {
  test('describes what the page had to be reduced to', () => {
    expect(describeOutcome({ action: 'summarized', from: 90_000, to: 12_000, unread: 21_192 }))
      .toBe('summarized 90k → 12k, 21k unread')
    // Nothing went unread, so the reduction is fully described by from → to.
    expect(describeOutcome({ action: 'truncated', from: 90_000, to: 12_000, unread: 0 }))
      .toBe('truncated 90k → 12k')
  })

  test('reports truncation to the caller, and stays silent when the page fitted', async () => {
    const [cut] = await processUrlsForContext(urls(1, 90_000), AMPLE_BUDGET, false, 12_000)
    expect(cut.outcome).toMatchObject({ action: 'truncated', from: 90_000, unread: 0 })

    const [whole] = await processUrlsForContext(urls(1, 500), AMPLE_BUDGET, false, 12_000)
    expect(whole.outcome).toBeUndefined()
  })
})

describe('worthSummarizing', () => {
  test('demands a 3x reduction before the small model is worth calling', () => {
    expect(worthSummarizing(120_000, 40_000)).toBe(true)
    expect(worthSummarizing(45_000, 40_000)).toBe(false)   // 4 LLM calls to remove 5k chars
  })
})

/** The summarizer's output used to be bounded only by a word count in the prompt, derived from the
 *  context cap and never from the input — so for content just over the cap it permitted a "summary"
 *  the size of its own source, and nothing stopped a model exceeding even that. */
describe('summarizeContent bounds', () => {
  const HUGE = 'summary. '.repeat(20_000)   // 180k chars, far over any cap
  let server: ReturnType<typeof startFakeOpenAI>

  beforeAll(() => {
    server = startFakeOpenAI([{ text: [HUGE] }])
    const model = createOpenAI({ baseURL: server.baseURL, apiKey: 'test' }).chat('fake-small')
    mock.module('./llm.ts', () => ({ ...realLlm, getSmallModel: () => model }))
  })
  afterAll(() => {
    server?.stop()
    mock.module('./llm.ts', () => realLlm)
  })

  test('caps a model that ignores its length instruction', async () => {
    const [out] = await processUrlsForContext(urls(1, 90_000), AMPLE_BUDGET, true, 12_000)
    expect(out.content.length).toBeLessThan(12_100)
    expect(out.content).toInclude('[summary truncated to fit context]')
  })

  test('tells the model how much of the page went unread', async () => {
    // 90k of page against 6 chunks of SMALL_MODEL_INPUT_CHARS — the tail cannot be covered, and
    // silently dropping it makes an unread section indistinguishable from an absent one.
    const [out] = await processUrlsForContext(urls(1, 90_000), AMPLE_BUDGET, true, 12_000)
    expect(out.content).toEndWith('may contain relevant information.]')
    expect(out.content).toInclude('of 90000 characters of this page were read')
    // The warning must survive the clamp that trims the summary body.
    expect(out.content.length).toBeLessThan(12_100)
  })

  test('says nothing when the whole page was read', async () => {
    const [out] = await processUrlsForContext(urls(1, 20_000), AMPLE_BUDGET, true, 5_000)
    expect(out.content).not.toInclude('were read')
  })

  test('asks the provider to enforce the length, not just the prompt', async () => {
    await processUrlsForContext(urls(1, 90_000), AMPLE_BUDGET, true, 12_000)
    const sent = server.requests.at(-1) as { max_tokens?: number; max_completion_tokens?: number }
    const cap = sent.max_tokens ?? sent.max_completion_tokens
    expect(cap).toBeGreaterThan(0)
    // Per chunk: min(target/chunks, chunkChars/3) converted to tokens — well under the whole cap.
    expect(cap! * realLlm.CHARS_PER_TOKEN).toBeLessThanOrEqual(12_000)
  })

  test('reports how much of the page was never read', async () => {
    const [out] = await processUrlsForContext(urls(1, 90_000), AMPLE_BUDGET, true, 12_000)
    // 6 chunks cover 68 808 of 90 000 chars; the rest is what the UI must be able to warn about.
    expect(out.outcome).toMatchObject({ action: 'summarized', from: 90_000 })
    expect(out.outcome!.unread).toBeGreaterThan(20_000)
  })

  test('truncates instead of summarizing when the page barely exceeds the cap', async () => {
    const before = server.callCount
    const [out] = await processUrlsForContext(urls(1, 13_000), AMPLE_BUDGET, true, 12_000)
    expect(server.callCount).toBe(before)              // the model was never called
    expect(out.content).toEndWith('[content truncated to fit context]')
  })
})
