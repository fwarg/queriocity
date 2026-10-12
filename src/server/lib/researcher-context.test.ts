/** The researcher budgets history against the context window of the model it was handed, not the
 *  global CONTEXT_TOKEN_LIMIT — the turn's model may be a different one with a different window. */

import { describe, test, expect, afterEach } from 'bun:test'
import { startFakeOpenAI, fakeTarget } from './test-support/fake-openai.ts'
import { envOverride } from './test-support/env-override.ts'
import type { ContextReport } from '../../shared/context.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const undo of cleanups.splice(0).reverse()) undo() })

/** Ten long turns, then the question. */
const HISTORY = [
  ...Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `turn ${i} `.padEnd(2000, 'x') })),
  { role: 'user' as const, content: 'and now?' },
]

async function firstReport(contextTokens: number): Promise<ContextReport> {
  cleanups.push(envOverride({ CONTEXT_TOKEN_LIMIT: '1000000' }))
  const fake = startFakeOpenAI([{ text: ['An answer.'] }])
  cleanups.push(() => fake.stop())
  const reports: ContextReport[] = []
  const { runResearcher } = await import('./researcher.ts')
  const res = await runResearcher({
    messages: HISTORY, focusMode: 'balanced', userId: 'u1', model: fakeTarget(fake.baseURL, contextTokens),
    onContext: r => { reports.push(r) },
  })
  for await (const part of res.stream) void part
  return reports[0]
}

describe('researcher context budget', () => {
  test('trims history to the handed model\'s window despite a large CONTEXT_TOKEN_LIMIT', async () => {
    const report = await firstReport(2000)
    expect(report.budgetChars).toBeLessThan(2000 * 4)
    expect(report.cut).toBeGreaterThan(0)
  })

  test('keeps the whole history when the handed model\'s window fits it', async () => {
    const report = await firstReport(100_000)
    expect(report.cut).toBe(0)
  })
})
