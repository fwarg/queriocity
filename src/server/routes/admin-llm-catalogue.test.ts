/** Admin LLM catalogue: validation on save, round trip, key status, and the per-model test probe. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { db, users, setAppSetting } from '../lib/db.ts'
import { adminRouter } from './admin.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'
import { CATALOGUE_SETTING, loadCatalogue } from '../lib/llm-catalogue.ts'
import { userSpend, getLlmAccess } from '../lib/llm-usage.ts'
import { startFakeOpenAI } from '../lib/test-support/fake-openai.ts'
import { envOverride } from '../lib/test-support/env-override.ts'
import type { LlmCatalogue } from '../../shared/llm-catalogue.ts'

const app = new Hono().route('/admin', adminRouter)
let cookie = ''
let fake: ReturnType<typeof startFakeOpenAI>
let restoreEnv: () => void

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: 'llm-admin', email: 'llm-admin@example.com', name: null, role: 'admin',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: 'llm-admin', email: 'llm-admin@example.com', role: 'admin', tokenVersion: 0 })}`
  fake = startFakeOpenAI([{ text: ['OK'], usage: { prompt_tokens: 100, completion_tokens: 10 } }])
  restoreEnv = envOverride({ TESTCLOUD_API_KEY: 'secret', MISSING_API_KEY: '' })
})

// The in-memory database is shared by every test file.
afterAll(async () => { fake.stop(); restoreEnv(); await setAppSetting(CATALOGUE_SETTING, '') })

const request = (method: string, path: string, body?: unknown) => app.request(`/admin${path}`, {
  method,
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

function catalogue(): LlmCatalogue {
  return {
    providers: [
      { id: 'cloud', label: 'Test cloud', baseURL: fake.baseURL, apiKeyEnv: 'TESTCLOUD_API_KEY', currency: 'EUR', monthlyCap: 20, enabled: true },
      { id: 'nokey', label: 'No key', baseURL: 'https://api.example.com/v1', apiKeyEnv: 'MISSING_API_KEY', currency: 'USD', monthlyCap: 0, enabled: true },
    ],
    models: [
      { id: 'big', providerId: 'cloud', model: 'vendor/big', label: 'Big', role: 'both', contextTokens: 128000, maxOutputTokens: 8000, priceIn: 3, priceOut: 15, enabled: true },
      { id: 'orphan-key', providerId: 'nokey', model: 'm', label: 'M', role: 'chat', contextTokens: 8192, maxOutputTokens: 2000, priceIn: 0.1, priceOut: 0.2, enabled: true },
    ],
  }
}

describe('admin LLM catalogue', () => {
  test('is empty until saved', async () => {
    const res = await (await request('GET', '/llm-catalogue')).json()
    expect(res.catalogue).toEqual({ providers: [], models: [] })
  })

  test('saves, reads back, and reports which keys are set', async () => {
    expect((await request('PUT', '/llm-catalogue', catalogue())).status).toBe(200)
    const res = await (await request('GET', '/llm-catalogue')).json()
    expect(res.catalogue).toEqual(catalogue())
    expect(res.keys).toEqual({ TESTCLOUD_API_KEY: true, MISSING_API_KEY: false })
  })

  test.each([
    ['a model of an unknown provider', (c: LlmCatalogue) => { c.models[0].providerId = 'ghost' }],
    ['duplicate model ids', (c: LlmCatalogue) => { c.models[1].id = 'big' }],
    ['plain http to a remote host', (c: LlmCatalogue) => { c.providers[1].baseURL = 'http://api.example.com/v1' }],
    // A provider naming another secret would send it as a bearer token to its base URL.
    ['a key env var not ending in _API_KEY', (c: LlmCatalogue) => { c.providers[0].apiKeyEnv = 'JWT_SECRET' }],
    ['an unknown role', (c: LlmCatalogue) => { (c.models[0] as { role: string }).role = 'small' }],
  ])('rejects %s and keeps the saved catalogue', async (_, mutate) => {
    const bad = catalogue()
    mutate(bad)
    expect((await request('PUT', '/llm-catalogue', bad)).status).toBe(400)
    expect(await loadCatalogue()).toEqual(catalogue())
  })

  test('probes a saved model through its provider with the key from env', async () => {
    const res = await (await request('POST', '/llm-catalogue/test', { modelId: 'big' })).json()
    expect(res).toMatchObject({ ok: true, info: 'OK' })
    const sent = fake.requests.at(-1) as { model: string }
    expect(sent.model).toBe('vendor/big')
    // Paid for like any call: 100 × 3 + 10 × 15 per million, on the admin who ran it.
    expect(userSpend('llm-admin', 'cloud')).toBeCloseTo(0.00045)
  })

  test('refuses to probe a model whose key is not set', async () => {
    const res = await (await request('POST', '/llm-catalogue/test', { modelId: 'orphan-key' })).json()
    expect(res.ok).toBe(false)
    expect(res.info).toContain('API key')
  })

  test('grants cloud access per provider and lists it with this month\'s usage', async () => {
    const put = (body: unknown) => request('PUT', '/users/llm-admin/llm-access', body)
    expect((await put({ cloudEnabled: true, budgets: { ghost: 5 } })).status).toBe(400)
    expect((await request('PUT', '/users/nobody/llm-access', { cloudEnabled: true, budgets: {} })).status).toBe(404)
    expect((await put({ cloudEnabled: true, budgets: { cloud: 5 } })).status).toBe(200)
    expect(getLlmAccess('llm-admin')).toEqual({ cloudEnabled: true, budgets: { cloud: 5 } })
    const res = await (await request('GET', '/llm-usage')).json()
    expect(res.access['llm-admin']).toEqual({ cloudEnabled: true, budgets: { cloud: 5 } })
    expect(res.usage.some((r: { userId: string; providerId: string }) => r.userId === 'llm-admin' && r.providerId === 'cloud')).toBe(true)
  })

  test('ignores a stored catalogue that no longer validates', async () => {
    await setAppSetting(CATALOGUE_SETTING, '{"providers":[{"id":"x"}],"models":[]}')
    expect(await loadCatalogue()).toEqual({ providers: [], models: [] })
  })
})
