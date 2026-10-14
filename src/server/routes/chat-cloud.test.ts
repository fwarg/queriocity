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
import type { LlmCatalogue, ModelChoices } from '../../shared/llm-catalogue.ts'

const { db, users, spaces, messages, setAppSetting } = await import('../lib/db.ts')
const { eq, and } = await import('drizzle-orm')
const { chatRouter } = await import('./chat.ts')
const { signToken, AUTH_COOKIE } = await import('../lib/auth.ts')
const { saveCatalogue, CATALOGUE_SETTING } = await import('../lib/llm-catalogue.ts')
const { setLlmAccess, recordLlmUsage, userSpend, monthlyLlmUsage } = await import('../lib/llm-usage.ts')
const { resolveTurnModels } = await import('../lib/cloud-models.ts')

const USER = 'cloud-user'
const ACKNOWLEDGED = JSON.stringify({ cloudAcknowledged: true })
const app = new Hono().route('/chat', chatRouter)
// Both over the 50 characters below which the chat route does not cache an answer.
const LONG = 'A cloud answer long enough to be cached by the chat route, which wants fifty characters.'
const LOCAL = 'A local answer, also long enough for the chat route to put it in its cache.'
let cookie = ''
let local: ReturnType<typeof startFakeOpenAI>
let cloud: ReturnType<typeof startFakeOpenAI>
let lan: ReturnType<typeof startFakeOpenAI>
let routed: ReturnType<typeof startFakeOpenAI>
let broken: ReturnType<typeof startFakeOpenAI>
let searxng: ReturnType<typeof startFakeSearxng>
let restoreEnv: () => void

const catalogue = (): LlmCatalogue => ({
  providers: [
    { id: 'cl', label: 'Cloud', kind: 'cloud', baseURL: cloud.baseURL, apiKeyEnv: 'CLOUDTEST_API_KEY', currency: 'EUR', monthlyCap: 100, extraBody: { eu_native: true }, enabled: true },
    // Like Cortecs: reports its own cost per response, in millionths, and which host served it.
    { id: 'rt', label: 'Router', kind: 'cloud', baseURL: routed.baseURL, apiKeyEnv: 'CLOUDTEST_API_KEY', currency: 'EUR', monthlyCap: 0, reportedCostUnit: 0.000001, enabled: true },
    { id: 'bad', label: 'Broken', kind: 'cloud', baseURL: broken.baseURL, apiKeyEnv: 'CLOUDTEST_API_KEY', currency: 'EUR', monthlyCap: 0, enabled: true },
    // A bigger model on this machine: no key, not metered.
    { id: 'lan', label: 'Big box', kind: 'local', baseURL: lan.baseURL, apiKeyEnv: '', currency: 'EUR', monthlyCap: 0, enabled: true },
  ],
  models: [
    { id: 'cl-both', providerId: 'cl', model: 'vendor/both', label: 'Both', role: 'both', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, enabled: true },
    { id: 'cl-think', providerId: 'cl', model: 'vendor/think', label: 'Think', role: 'thinking', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, enabled: true },
    // Pinned to one hosting provider, overriding one of the provider's own extras.
    { id: 'cl-pinned', providerId: 'cl', model: 'vendor/pinned', label: 'Pinned', role: 'chat', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, extraBody: { allowed_providers: ['host-a'], provider_order: 'custom', eu_native: false }, enabled: true },
    { id: 'cl-off', providerId: 'cl', model: 'vendor/off', label: 'Off', role: 'chat', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, enabled: false },
    { id: 'rt-model', providerId: 'rt', model: 'routed', label: 'Routed', role: 'chat', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, enabled: true },
    { id: 'bad-model', providerId: 'bad', model: 'missing', label: 'Missing', role: 'chat', contextTokens: 64000, maxOutputTokens: 3000, priceIn: 1, priceOut: 1, enabled: true },
    { id: 'lan-big', providerId: 'lan', model: 'big-local', label: 'Big local', role: 'both', contextTokens: 32000, maxOutputTokens: 4000, priceIn: 0, priceOut: 0, enabled: true },
  ],
})

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({ id: USER, email: `${USER}@example.com`, name: null, role: 'user', settings: ACKNOWLEDGED, tokenVersion: 0, createdAt: now, updatedAt: now })
  await db.insert(spaces).values({ id: 'cloud-locked', name: 'L', userId: USER, offline: true, createdAt: now, updatedAt: now })
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: USER, email: `${USER}@example.com`, role: 'user', tokenVersion: 0 })}`
  await setAppSetting('query_reformulation', 'false')
  local = startFakeOpenAI([{ text: [LOCAL] }])
  cloud = startFakeOpenAI([{ text: [LONG], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }])
  routed = startFakeOpenAI([{ text: [LONG], usage: { prompt_tokens: 14, completion_tokens: 73, cost: 25 }, headers: { 'x-cortecs-provider': 'entrim' } }])
  broken = startFakeOpenAI([{ error: { status: 404, message: 'Model missing does not exist' } }])
  lan = startFakeOpenAI([{ text: ['From the big local model.'], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }])
  searxng = startFakeSearxng()
  restoreEnv = envOverride({
    CHAT_BASE_URL: local.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'local', CLOUDTEST_API_KEY: 'secret',
    SEARXNG_URL: searxng.url, SPEJAREN_URL: '', SEARCH_API_PROVIDER: '', RERANK_MODEL: '', THINKING_MODEL: '',
  })
  await saveCatalogue(catalogue())
})

beforeEach(() => setLlmAccess(USER, { cloudEnabled: true, budgets: { cl: 10, rt: 10, bad: 10, lan: 0 } }))

afterAll(async () => {
  local.stop(); cloud.stop(); routed.stop(); broken.stop(); lan.stop(); searxng.stop(); restoreEnv()
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
  resolveTurnModels({ userId: USER, modelId, focusMode, locked, cloudAcknowledged: true })

describe('a cloud pick', () => {
  test('answers flash on the cloud model, with its extras and output cap, and is metered', async () => {
    const before = userSpend(USER, 'cl')
    const events = await chat({ modelId: 'cl-both', messages: [{ role: 'user', content: 'Pick cloud' }] })
    expect(answerOf(events)).toBe(LONG)
    expect(noticeOf(events)).toBeUndefined()
    expect(events[1]).toEqual({ type: 'model', id: 'cl-both', label: 'Both', kind: 'cloud', provider: 'Cloud' })
    const sent = cloud.requests.at(-1) as { model: string; eu_native?: boolean; max_tokens?: number }
    expect(sent).toMatchObject({ model: 'vendor/both', eu_native: true, max_tokens: 3000 })
    expect(userSpend(USER, 'cl') - before).toBeCloseTo(0.002)
  })

  test('charges the provider\'s own cost and records the host it routed to', async () => {
    const before = userSpend(USER, 'rt')
    const events = await chat({ modelId: 'rt-model', ephemeral: false, sessionId: 'cloud-routed', messages: [{ role: 'user', content: 'Routed' }] })
    // 25 millionths of a euro, not the catalogue estimate of (14 + 73) / 1e6.
    expect(userSpend(USER, 'rt') - before).toBeCloseTo(0.000025, 9)
    const answered = { id: 'rt-model', label: 'Routed', kind: 'cloud', provider: 'Router', via: 'entrim', cost: 0.000025, currency: 'EUR' }
    const done = events.find(e => e.type === 'done')?.model as typeof answered
    expect({ ...done, cost: undefined }).toEqual({ ...answered, cost: undefined })
    expect(done.cost).toBeCloseTo(0.000025, 9)
    const stored = await db.select({ model: messages.model }).from(messages)
      .where(and(eq(messages.sessionId, 'cloud-routed'), eq(messages.role, 'assistant'))).get()
    expect(JSON.parse(stored?.model ?? 'null')).toEqual(done)
  })

  test('says why when the cloud model fails, in the provider\'s words', async () => {
    const events = await chat({ modelId: 'bad-model', messages: [{ role: 'user', content: 'Fails' }] })
    const error = events.find(e => e.type === 'model_error')
    expect(error).toMatchObject({ provider: 'Broken' })
    expect(String(error?.message)).toContain('Model missing does not exist')
    expect(events.map(e => e.type).indexOf('model_error')).toBeLessThan(events.map(e => e.type).indexOf('done'))
  })

  test('sends a model\'s own extras over its provider\'s', async () => {
    await chat({ modelId: 'cl-pinned', messages: [{ role: 'user', content: 'Pinned' }] })
    expect(cloud.requests.at(-1)).toMatchObject({ model: 'vendor/pinned', allowed_providers: ['host-a'], provider_order: 'custom', eu_native: false })
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
    // Each stored answer records the model that wrote it, the default one included, and what the
    // answer cost: the catalogue estimate here, (1000 + 1000) × 1 per million, and nothing for a
    // cached replay, which made no calls.
    const storedModel = async (n: number) => JSON.parse((await db.select({ model: messages.model }).from(messages)
      .where(and(eq(messages.sessionId, `cloud-cache-${n}`), eq(messages.role, 'assistant'))).get())?.model ?? 'null')
    const defaultModel = { id: 'local', label: 'local', kind: 'default' }
    const cloudModel = { id: 'cl-both', label: 'Both', kind: 'cloud', provider: 'Cloud' }
    expect([await storedModel(1), await storedModel(3), await storedModel(4)]).toEqual([defaultModel, defaultModel, cloudModel])
    expect(await storedModel(2)).toMatchObject({ ...cloudModel, currency: 'EUR' })
    expect((await storedModel(2)).cost).toBeCloseTo(0.002)
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

  test('is refused until the user has confirmed that cloud models are not private', async () => {
    await db.update(users).set({ settings: '{}' }).where(eq(users.id, USER))
    try {
      const cloudCalls = cloud.callCount
      const events = await chat({ modelId: 'cl-both', messages: [{ role: 'user', content: 'Unconfirmed' }] })
      expect(noticeOf(events)).toMatchObject({ reason: 'unacknowledged' })
      expect(cloud.callCount).toBe(cloudCalls)
      // A local provider sends nothing off the server, so it needs no confirmation.
      expect(noticeOf(await chat({ modelId: 'lan-big', messages: [{ role: 'user', content: 'Unconfirmed local' }] }))).toBeUndefined()
    } finally {
      await db.update(users).set({ settings: ACKNOWLEDGED }).where(eq(users.id, USER))
    }
  })

  test('stays local in a locked space', async () => {
    const events = await chat({ modelId: 'cl-both', spaceId: 'cloud-locked', messages: [{ role: 'user', content: 'Locked' }] })
    expect(noticeOf(events)).toMatchObject({ reason: 'locked' })
  })
})

describe('resolving a pick', () => {
  test('leaves a turn with no pick on the local models', async () => {
    const r = await resolveTurnModels({ userId: USER, focusMode: 'flash', locked: false, cloudAcknowledged: true })
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

describe('a local provider', () => {
  test('answers without a key, unmetered, and in a locked space when on this network', async () => {
    const before = monthlyLlmUsage()
    const events = await chat({ modelId: 'lan-big', spaceId: 'cloud-locked', messages: [{ role: 'user', content: 'Big local' }] })
    expect(noticeOf(events)).toBeUndefined()
    expect(answerOf(events)).toBe('From the big local model.')
    expect((lan.requests.at(-1) as { model: string }).model).toBe('big-local')
    expect(monthlyLlmUsage()).toEqual(before)
  })

  test('still needs the user to be granted it', async () => {
    setLlmAccess(USER, { cloudEnabled: true, budgets: { cl: 10 } })
    expect((await pick('lan-big')).fallback?.reason).toBe('not_allowed')
  })
})

describe('GET /chat/models', () => {
  // The cap test above spent the provider's whole cap for this month; lift it for these.
  beforeAll(() => saveCatalogue({ ...catalogue(), providers: catalogue().providers.map(p => ({ ...p, monthlyCap: 0 })) }))

  const choices = async () => (await app.request('/chat/models', { headers: { Cookie: cookie } })).json() as Promise<ModelChoices>
  const list = async () => (await choices()).models

  test('lists the enabled, granted models with what is left of each cloud budget', async () => {
    setLlmAccess(USER, { cloudEnabled: true, budgets: { cl: userSpend(USER, 'cl') + 4, lan: 0 } })
    const models = await list()
    expect(models.map(m => m.id)).toEqual(['cl-both', 'cl-think', 'cl-pinned', 'lan-big'])
    expect(models[0]).toMatchObject({ kind: 'cloud', currency: 'EUR', allowedWhenLocked: false })
    expect(models[0].remaining).toBeCloseTo(4)
    const lanModel = models.find(m => m.id === 'lan-big')
    expect(lanModel).toMatchObject({ kind: 'local', allowedWhenLocked: true })
    expect(lanModel?.remaining).toBeUndefined()
  })

  test('sizes the meter per model: a pick by its own window, the defaults by theirs', async () => {
    const { models, defaults } = await choices()
    // The input share (0.8) of the window, at 4 characters per token.
    expect(models.find(m => m.id === 'cl-both')?.budgetChars).toBe(64000 * 0.8 * 4)
    expect(models.find(m => m.id === 'lan-big')?.budgetChars).toBe(32000 * 0.8 * 4)
    expect(defaults.chat).toEqual({ model: 'local', budgetChars: Math.floor(8192 * 0.8 * 4) })
  })

  test('drops cloud models whose budget is spent, and lists nothing when picking is off', async () => {
    setLlmAccess(USER, { cloudEnabled: true, budgets: { cl: userSpend(USER, 'cl'), lan: 0 } })
    expect((await list()).map(m => m.id)).toEqual(['lan-big'])
    setLlmAccess(USER, { cloudEnabled: false, budgets: { cl: 10, lan: 0 } })
    const off = await choices()
    expect(off.models).toEqual([])
    // The meter still needs the default models' sizes.
    expect(off.defaults.chat.budgetChars).toBeGreaterThan(0)
  })
})
