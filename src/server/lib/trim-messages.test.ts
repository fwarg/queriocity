/** History trimming: oldest unpinned messages go first, pinned ones stay (shortened only when they
 *  alone overflow), and the report says where the model's view of the conversation begins. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { ModelMessage } from 'ai'
import { startFakeOpenAI } from './test-support/fake-openai.ts'
import { envOverride } from './test-support/env-override.ts'

const { trimMessages, compressMessages } = await import('./trim-messages.ts')
const { SMALL_MODEL_INPUT_CHARS, CHARS_PER_TOKEN } = await import('./llm.ts')

/** A message of about `tokens` estimated tokens (chars / 4, plus JSON overhead). */
const msg = (role: 'user' | 'assistant', label: string, tokens = 100): ModelMessage =>
  ({ role, content: `${label} ${'x'.repeat(tokens * 4)}` })

const labels = (ms: ModelMessage[]) => ms.map(m => String(m.content).split(' ')[0])

/** Ten alternating messages of ~100 tokens each: q0 a1 q2 a3 … a9. */
const conversation = () => Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `${i % 2 ? 'a' : 'q'}${i}`))

describe('trimMessages', () => {
  test('keeps everything, and reports nothing cut, when it fits', () => {
    const { messages, report } = trimMessages(conversation(), 10_000)
    expect(messages).toHaveLength(10)
    expect(report).toMatchObject({ cut: 0, lostBefore: 0, pinnedChars: 0, pinnedTruncated: false, budgetChars: 10_000 * CHARS_PER_TOKEN })
  })

  test('drops the oldest first and reports the cut', () => {
    const { messages, report } = trimMessages(conversation(), 450)
    expect(labels(messages)).toEqual(['q6', 'a7', 'q8', 'a9'])
    expect(report.cut).toBe(6)
    expect(report.lostBefore).toBe(6)
    expect(report.historyChars).toBeLessThanOrEqual(450 * CHARS_PER_TOKEN)
  })

  test('keeps a pinned message in place while newer unpinned ones drop', () => {
    const { messages, report } = trimMessages(conversation(), 450, '', new Set([0]))
    expect(labels(messages)).toEqual(['q0', 'a7', 'q8', 'a9'])
    expect(report.cut).toBe(7)
    expect(report.pinnedChars).toBeGreaterThan(100)
    expect(report.historyChars).toBeGreaterThan(300)
  })

  test('shortens pinned messages, never below a readable head, when the pins alone overflow', () => {
    const history = [msg('user', 'doc', 5000), msg('assistant', 'a1'), msg('user', 'q2')]
    const { messages, report } = trimMessages(history, 1000, '', new Set([0]))
    expect(labels(messages)).toEqual(['doc', 'q2'])
    expect(report.pinnedTruncated).toBe(true)
    expect(String(messages[0].content)).toEndWith('[…truncated to fit the context window]')
    expect(String(messages[0].content).length).toBeLessThan(5000 * 4)
    // The caller's array is not modified.
    expect(String(history[0].content).length).toBeGreaterThan(5000 * 4)
  })

  test('counts injected search results apart from the conversation', () => {
    const history: ModelMessage[] = [
      msg('user', 'q0'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'pre-0', toolName: 'web_search', input: { queries: ['bees'] } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'pre-0', toolName: 'web_search', output: { type: 'json', value: 'x'.repeat(2000) } }] },
    ]
    const { report } = trimMessages(history, 10_000)
    expect(report.searchChars).toBeGreaterThan(2000)
    expect(report.historyChars).toBeLessThan(200 * CHARS_PER_TOKEN)
  })

  test('keeps only the last message, pinned or not, when the system prompt alone exceeds the budget', () => {
    const { messages } = trimMessages(conversation(), 10, 'y'.repeat(400), new Set([0]))
    expect(labels(messages)).toEqual(['a9'])
  })
})

describe('compressMessages', () => {
  let server: ReturnType<typeof startFakeOpenAI>
  let restoreEnv: () => void

  beforeAll(() => {
    server = startFakeOpenAI(Array.from({ length: 20 }, () => ({ text: ['Earlier: the user asked about bees.'] })))
    restoreEnv = envOverride({ CHAT_BASE_URL: server.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'fake-small' })
  })
  afterAll(() => { server?.stop(); restoreEnv?.() })

  test('summarises what it drops, never a pinned message, and reports the summary', async () => {
    const { messages, summary, report } = await compressMessages(conversation(), 450, '', 2000, new Set([0]))
    expect(labels(messages)).toEqual(['q0', 'a7', 'q8', 'a9'])
    expect(summary).toContain('bees')
    expect(report).toMatchObject({ cut: 7, lostBefore: 0, summary })
    expect(report.summaryChars).toBeGreaterThan(0)
  })

  test('reports as lost the oldest messages that fall outside what the summary covers', async () => {
    // Each message is a third of the summariser's whole input window, so the oldest of many fall out.
    const big = Math.ceil((6 * SMALL_MODEL_INPUT_CHARS) / 3 / 4)
    const history = Array.from({ length: 8 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`, big))
    const { report } = await compressMessages(history, big + 50, '', 2000)
    expect(report.cut).toBe(7)
    expect(report.lostBefore).toBeGreaterThan(0)
    expect(report.lostBefore).toBeLessThan(report.cut)
  })
})
