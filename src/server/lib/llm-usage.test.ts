/** Cloud spend metering: every call on a metered target is priced from the catalogue and recorded
 *  per user, provider and month — streamed or not — and summed for the provider's cap. */

// Must precede the imports below — they reach lib/db.ts, which reads env at load.
import './test-support/test-env.ts'

import { describe, test, expect, afterEach } from 'bun:test'
import { streamText, generateText } from 'ai'
import { startFakeOpenAI, fakeTarget } from './test-support/fake-openai.ts'
import { languageModel } from './llm.ts'
import { costOf, callCost, reconcileGeneration, addAnswerCost, meteredUsage, userSpend, providerSpend, monthlyLlmUsage, recordLlmUsage, getLlmAccess, setLlmAccess, allLlmAccess } from './llm-usage.ts'
import { db, users, chatSessions, messages } from './db.ts'
import { eq } from 'drizzle-orm'
import type { CloudModel } from '../../shared/llm-catalogue.ts'

let fake: ReturnType<typeof startFakeOpenAI> | null = null
afterEach(() => { fake?.stop(); fake = null })

const MODEL: CloudModel = {
  id: 'meter-model', providerId: 'meter-cloud', model: 'm', label: 'M', role: 'both',
  contextTokens: 8192, maxOutputTokens: 1000, priceIn: 2, priceOut: 10, enabled: true,
}

function meteredTarget(userId: string) {
  fake = startFakeOpenAI([{ text: ['Hi.'], usage: { prompt_tokens: 1000, completion_tokens: 500 } }])
  return { ...fakeTarget(fake.baseURL), onUsage: meteredUsage(userId, MODEL, { currency: 'EUR' }) }
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

describe('stopped calls looked up by generation id', () => {
  test('adds the difference between the estimate and the real cost, once the stats are ready', async () => {
    let asked = 0
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        asked++
        expect(new URL(req.url).searchParams.get('id')).toBe('gen-42')
        expect(req.headers.get('authorization')).toBe('Bearer k')
        // Not ready on the first lookup.
        if (asked === 1) return new Response('Not Found', { status: 404 })
        return Response.json({ data: { total_cost: 0.5, tokens_prompt: 100, tokens_completion: 40 } })
      },
    })
    try {
      recordLlmUsage('gen-user', 'gen-cloud', { inputTokens: 90, outputTokens: 10 }, 0.2)
      const corrections: number[] = []
      const done = await reconcileGeneration({
        userId: 'gen-user', providerId: 'gen-cloud', endpoint: { baseURL: `http://localhost:${server.port}/api/v1`, apiKey: 'k' },
        generationId: 'gen-42', estimate: { inputTokens: 90, outputTokens: 10 }, estimatedCost: 0.2,
        onCorrection: d => { corrections.push(d) },
      }, [0, 0])
      expect(done).toBe(true)
      expect(corrections[0]).toBeCloseTo(0.3)
      const row = monthlyLlmUsage().find(r => r.userId === 'gen-user')
      // The real figures, and still one request.
      expect(row).toMatchObject({ inputTokens: 100, outputTokens: 40, requests: 1 })
      expect(row?.cost).toBeCloseTo(0.5)
    } finally {
      server.stop(true)
    }
  })

  test('leaves the estimate when the provider never reports', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('Not Found', { status: 404 }) })
    try {
      const done = await reconcileGeneration({
        userId: 'gen-user-2', providerId: 'gen-cloud', endpoint: { baseURL: `http://localhost:${server.port}` },
        generationId: 'gen-43', estimate: { inputTokens: 1, outputTokens: 1 }, estimatedCost: 0.1,
      }, [0])
      expect(done).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})

describe('an answer\'s stored cost', () => {
  test('is corrected by a late difference, and an answer without a cost is left alone', async () => {
    const now = new Date()
    await db.insert(users).values({ id: 'cost-u', email: 'cost-u@example.com', name: null, role: 'user', settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now })
    await db.insert(chatSessions).values({ id: 'cost-chat', title: 'c', userId: 'cost-u', createdAt: now, updatedAt: now })
    await db.insert(messages).values([
      { id: 'cost-a', sessionId: 'cost-chat', role: 'assistant', content: 'a', model: JSON.stringify({ id: 'm', label: 'M', kind: 'cloud', provider: 'P', cost: 0.2, currency: 'USD' }), createdAt: now },
      { id: 'cost-b', sessionId: 'cost-chat', role: 'assistant', content: 'b', model: JSON.stringify({ id: 'llama', label: 'llama', kind: 'default' }), createdAt: now },
    ])
    addAnswerCost('cost-a', 0.3)
    addAnswerCost('cost-b', 0.3)
    const stored = async (id: string) => JSON.parse((await db.select({ model: messages.model }).from(messages).where(eq(messages.id, id)).get())?.model ?? 'null')
    expect((await stored('cost-a')).cost).toBeCloseTo(0.5)
    expect(await stored('cost-b')).toEqual({ id: 'llama', label: 'llama', kind: 'default' })
  })
})
