/** Cloud spend metering: every call on a metered target is priced from the catalogue and recorded
 *  per user, provider and month — streamed or not — and summed for the provider's cap. */

// Must precede the imports below — they reach lib/db.ts, which reads env at load.
import './test-support/test-env.ts'

import { describe, test, expect, afterEach } from 'bun:test'
import { streamText, generateText } from 'ai'
import { startFakeOpenAI, fakeTarget } from './test-support/fake-openai.ts'
import { languageModel } from './llm.ts'
import { costOf, callCost, meteredUsage, userSpend, providerSpend, monthlyLlmUsage, recordLlmUsage, getLlmAccess, setLlmAccess, allLlmAccess } from './llm-usage.ts'
import { db, users } from './db.ts'
import type { CloudModel } from '../../shared/llm-catalogue.ts'

let fake: ReturnType<typeof startFakeOpenAI> | null = null
afterEach(() => { fake?.stop(); fake = null })

const MODEL: CloudModel = {
  id: 'meter-model', providerId: 'meter-cloud', model: 'm', label: 'M', role: 'both',
  contextTokens: 8192, maxOutputTokens: 1000, priceIn: 2, priceOut: 10, enabled: true,
}

function meteredTarget(userId: string) {
  fake = startFakeOpenAI([{ text: ['Hi.'], usage: { prompt_tokens: 1000, completion_tokens: 500 } }])
  return { ...fakeTarget(fake.baseURL), onUsage: meteredUsage(userId, MODEL, {}) }
}

describe('cloud usage metering', () => {
  test('uses the provider\'s own cost when its unit is known, else the estimate', () => {
    const call = { inputTokens: 14, outputTokens: 73, reportedCost: 25 }
    expect(callCost(call, MODEL, 0.000001)).toBeCloseTo(0.000025)
    expect(callCost(call, MODEL)).toBeCloseTo((14 * 2 + 73 * 10) / 1_000_000)
    expect(callCost({ inputTokens: 14, outputTokens: 73 }, MODEL, 0.000001)).toBeCloseTo((14 * 2 + 73 * 10) / 1_000_000)
  })

  test('prices tokens per million', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 500_000 }, MODEL)).toBe(7)
  })

  test('records a streamed call from its final usage chunk', async () => {
    const result = streamText({ model: languageModel(meteredTarget('meter-a')), prompt: 'Hello' })
    expect(await result.text).toBe('Hi.')
    // 1000 × 2 + 500 × 10 per million.
    expect(userSpend('meter-a', 'meter-cloud')).toBeCloseTo(0.007)
  })

  test('records a non-streamed call', async () => {
    await generateText({ model: languageModel(meteredTarget('meter-b')), prompt: 'Hello' })
    expect(userSpend('meter-b', 'meter-cloud')).toBeCloseTo(0.007)
  })

  test('adds up calls per user and across users for the provider cap', () => {
    recordLlmUsage('meter-c', 'meter-cap', { inputTokens: 10, outputTokens: 5 }, 1.5)
    recordLlmUsage('meter-c', 'meter-cap', { inputTokens: 10, outputTokens: 5 }, 0.5)
    recordLlmUsage('meter-d', 'meter-cap', { inputTokens: 1, outputTokens: 1 }, 3)
    expect(userSpend('meter-c', 'meter-cap')).toBe(2)
    expect(providerSpend('meter-cap')).toBe(5)
    const row = monthlyLlmUsage().find(r => r.userId === 'meter-c' && r.providerId === 'meter-cap')
    expect(row).toEqual({ userId: 'meter-c', providerId: 'meter-cap', cost: 2, inputTokens: 20, outputTokens: 10, requests: 2 })
  })

  test('leaves unmetered targets alone', async () => {
    fake = startFakeOpenAI([{ text: ['Hi.'], usage: { prompt_tokens: 1000, completion_tokens: 500 } }])
    const before = monthlyLlmUsage()
    await generateText({ model: languageModel(fakeTarget(fake.baseURL)), prompt: 'Hello' })
    expect(monthlyLlmUsage()).toEqual(before)
  })
})

describe('cloud access', () => {
  test('replaces the whole grant and reads it back', async () => {
    const now = new Date()
    await db.insert(users).values({ id: 'access-u', email: 'access-u@example.com', name: null, role: 'user', settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now })
    expect(getLlmAccess('access-u')).toEqual({ cloudEnabled: false, budgets: {} })
    setLlmAccess('access-u', { cloudEnabled: true, budgets: { a: 5, b: 10 } })
    setLlmAccess('access-u', { cloudEnabled: true, budgets: { b: 20 } })
    expect(getLlmAccess('access-u')).toEqual({ cloudEnabled: true, budgets: { b: 20 } })
    expect(allLlmAccess()['access-u']).toEqual({ cloudEnabled: true, budgets: { b: 20 } })
  })
})
