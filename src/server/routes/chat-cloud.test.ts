/** Per-message cloud model picks: which slots a pick fills, every reason a pick falls back to the
 *  local model, metering, the cache boundary between cloud and local answers, and provider extras.
 *  Two fake model servers stand in for the local and the cloud model. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { startFakeOpenAI } from '../lib/test-support/fake-openai.ts'
import { startFakeSearxng, type SseEvent } from '../lib/test-support/fake-searxng.ts'
import { envOverride } from '../lib/test-support/env-override.ts'
import type { LlmCatalogue } from '../../shared/llm-catalogue.ts'

const { db, users, spaces, setAppSetting } = await import('../lib/db.ts')
const { chatRouter } = await import('./chat.ts')
const { signToken, AUTH_COOKIE } = await import('../lib/auth.ts')
const { saveCatalogue, CATALOGUE_SETTING } = await import('../lib/llm-catalogue.ts')
const { setLlmAccess, recordLlmUsage, userSpend } = await import('../lib/llm-usage.ts')
const { resolveTurnModels } = await import('../lib/cloud-models.ts')

const USER = 'cloud-user'
const app = new Hono().route('/chat', chatRouter)
// Both over the 50 characters below which the chat route does not cache an answer.
const LONG = 'A cloud answer long enough to be cached by the chat route, which wants fifty characters.'
const LOCAL = 'A local answer, also long enough for the chat route to put it in its cache.'
let cookie = ''
let local: ReturnType<typeof startFakeOpenAI>
let cloud: ReturnType<typeof startFakeOpenAI>
let searxng: ReturnType<typeof startFakeSearxng>
let restoreEnv: () => void

const catalogue = (): LlmCatalogue => ({
  providers: [
    { id: 'cl', label: 'Cloud', baseURL: cloud.baseURL, apiKeyEnv: 'CLOUDTEST_API_KEY', currency: 'EUR', monthlyCap: 100, extraBody: { eu_native: true }, enabled: true },
  ],
  models: [
    { id: 'cl-both', providerId: 'cl', model: 'vendor/both', label: 'Both', role: 'both', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, enabled: true },
    { id: 'cl-think', providerId: 'cl', model: 'vendor/think', label: 'Think', role: 'thinking', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, enabled: true },
    { id: 'cl-off', providerId: 'cl', model: 'vendor/off', label: 'Off', role: 'chat', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, enabled: false },
  ],
})

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({ id: USER, email: `${USER}@example.com`, name: null, role: 'user', settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now })
  await db.insert(spaces).values({ id: 'cloud-locked', name: 'L', userId: USER, offline: true, createdAt: now, updatedAt: now })
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: USER, email: `${USER}@example.com`, role: 'user', tokenVersion: 0 })}`
  await setAppSetting('query_reformulation', 'false')
  local = startFakeOpenAI([{ text: [LOCAL] }])
  cloud = startFakeOpenAI([{ text: [LONG], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }])
  searxng = startFakeSearxng()
  restoreEnv = envOverride({
    CHAT_BASE_URL: local.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'local', CLOUDTEST_API_KEY: 'secret',
    SEARXNG_URL: searxng.url, SPEJAREN_URL: '', SEARCH_API_PROVIDER: '', RERANK_MODEL: '', THINKING_MODEL: '',
  })
  await saveCatalogue(catalogue())
})

beforeEach(() => setLlmAccess(USER, { cloudEnabled: true, budgets: { cl: 10 } }))

afterAll(async () => {
  local.stop(); cloud.stop(); searxng.stop(); restoreEnv()
  await setAppSetting(CATALOGUE_SETTING, '')
})

async function chat(body: Record<string, unknown>): Promise<SseEvent[]> {
  const res = await app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ focusMode: 'flash', ephemeral: true, ...body }),
  })
  return (await res.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
}

const answerOf = (events: SseEvent[]) => events.filter(e => e.type === 'text').map(e => e.delta).join('')
const noticeOf = (events: SseEvent[]) => events.find(e => e.type === 'model_notice')
const pick = (modelId: string, focusMode: 'flash' | 'balanced' | 'thorough' | 'image' = 'flash', locked = false) =>
  resolveTurnModels({ userId: USER, modelId, focusMode, locked })

describe('a cloud pick', () => {
  test('answers flash on the cloud model, with its extras and output cap, and is metered', async () => {
    const before = userSpend(USER, 'cl')
    const events = await chat({ modelId: 'cl-both', messages: [{ role: 'user', content: 'Pick cloud' }] })
    expect(answerOf(events)).toBe(LONG)
    expect(noticeOf(events)).toBeUndefined()
    const sent = cloud.requests.at(-1) as { model: string; eu_native?: boolean; max_tokens?: number }
    expect(sent).toMatchObject({ model: 'vendor/both', eu_native: true, max_tokens: 3000 })
    expect(userSpend(USER, 'cl') - before).toBeCloseTo(0.002)
  })

  test('is never served a cached local answer, nor the reverse', async () => {
    const ask = (n: number, modelId?: string) =>
      chat({ modelId, messages: [{ role: 'user', content: 'Same question' }], ephemeral: false, sessionId: `cloud-cache-${n}` })
    expect(answerOf(await ask(1))).toBe(LOCAL)
    const cloudCalls = cloud.callCount
    expect(answerOf(await ask(2, 'cl-both'))).toBe(LONG)
    expect(cloud.callCount).toBe(cloudCalls + 1)
    // Both are cached now, each under its own model.
    const localCalls = local.callCount
    expect(answerOf(await ask(3))).toBe(LOCAL)
    expect(answerOf(await ask(4, 'cl-both'))).toBe(LONG)
    expect([local.callCount, cloud.callCount]).toEqual([localCalls, cloudCalls + 1])
  })

  test('runs only thorough research on a thinking model; the local model writes the answer', async () => {
    const [cloudCalls, localCalls] = [cloud.callCount, local.callCount]
    const events = await chat({ modelId: 'cl-think', focusMode: 'thorough', messages: [{ role: 'user', content: 'Think hard' }] })
    expect(noticeOf(events)).toBeUndefined()
    expect(answerOf(events)).toBe(LOCAL)
    expect(cloud.callCount).toBe(cloudCalls + 1)
    expect((cloud.requests.at(-1) as { tools?: unknown[] }).tools?.length).toBeGreaterThan(0)
    expect(local.callCount).toBe(localCalls + 1)
    expect(JSON.stringify(local.requests.at(-1))).toContain(LONG.slice(0, 30))
  })

  test('falls back with a notice when refused, and the local model answers', async () => {
    const localCalls = local.callCount
    const events = await chat({ modelId: 'no-such-model', messages: [{ role: 'user', content: 'Refused pick' }] })
    expect(noticeOf(events)).toMatchObject({ reason: 'unavailable' })
    expect(events.map(e => e.type).slice(0, 2)).toEqual(['session', 'model_notice'])
    expect(answerOf(events)).toBe(LOCAL)
    expect(local.callCount).toBe(localCalls + 1)
  })

  test('stays local in a locked space', async () => {
    const events = await chat({ modelId: 'cl-both', spaceId: 'cloud-locked', messages: [{ role: 'user', content: 'Locked' }] })
    expect(noticeOf(events)).toMatchObject({ reason: 'locked' })
  })
})

describe('resolving a pick', () => {
  test('leaves a turn with no pick on the local models', async () => {
    const r = await resolveTurnModels({ userId: USER, focusMode: 'flash', locked: false })
    expect(r.models.chat.baseURL).toBe(local.baseURL)
    expect(r.fallback).toBeUndefined()
  })

  test('puts a "both" model in every slot', async () => {
    const { models, forceThinking } = await pick('cl-both', 'thorough')
    expect([models.chat.model, models.flash.model, models.thinking.model]).toEqual(['vendor/both', 'vendor/both', 'vendor/both'])
    expect(forceThinking).toBe(false)
  })

  test('puts a thinking model in the thinking slot only, and switches thinking on', async () => {
    const { models, forceThinking } = await pick('cl-think', 'thorough')
    expect(models.thinking.model).toBe('vendor/think')
    expect(models.chat.baseURL).toBe(local.baseURL)
    expect(forceThinking).toBe(true)
  })

  test.each([
    ['a thinking model outside thorough', () => pick('cl-think', 'balanced'), 'mode'],
    ['image mode', () => pick('cl-both', 'image'), 'mode'],
    ['a disabled model', () => pick('cl-off'), 'unavailable'],
    ['a locked space', () => pick('cl-both', 'flash', true), 'locked'],
  ] as const)('refuses %s', async (_, run, reason) => {
    expect((await run()).fallback?.reason).toBe(reason)
  })

  test('refuses a user without cloud access, or without a budget for the provider', async () => {
    setLlmAccess(USER, { cloudEnabled: false, budgets: { cl: 10 } })
    expect((await pick('cl-both')).fallback?.reason).toBe('not_allowed')
    setLlmAccess(USER, { cloudEnabled: true, budgets: {} })
    expect((await pick('cl-both')).fallback?.reason).toBe('not_allowed')
  })

  test('refuses once the user\'s budget is spent', async () => {
    setLlmAccess(USER, { cloudEnabled: true, budgets: { cl: userSpend(USER, 'cl') } })
    expect((await pick('cl-both')).fallback?.reason).toBe('budget')
  })

  test('refuses once the provider\'s cap is reached by anyone', async () => {
    recordLlmUsage('someone-else', 'cl', { inputTokens: 0, outputTokens: 0 }, 100)
    expect((await pick('cl-both')).fallback?.reason).toBe('cap')
  })
})
