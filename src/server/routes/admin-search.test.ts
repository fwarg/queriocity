/** Admin search-policy round trip: env defaults until saved, validation on save, reset back. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { db, users } from '../lib/db.ts'
import { adminRouter } from './admin.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'
import { resetSearchPolicy } from '../lib/search/policy.ts'

const app = new Hono().route('/admin', adminRouter)
let cookie = ''

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: 'search-admin', email: 'search-admin@example.com', name: null, role: 'admin',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: 'search-admin', email: 'search-admin@example.com', role: 'admin', tokenVersion: 0 })}`
})

// The in-memory database is shared by every test file; a stored policy would change their searches.
afterAll(resetSearchPolicy)

const get = async () => (await app.request('/admin/search', { headers: { Cookie: cookie } })).json()
const put = (body: unknown) => app.request('/admin/search', {
  method: 'PUT',
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

describe('admin search policy', () => {
  test('starts from env defaults and lists every provider', async () => {
    const res = await get()
    expect(res.stored).toBe(false)
    expect(res.policy.fusion).toBe('legacy')
    expect(res.providers.map((p: { id: string }) => p.id)).toEqual(['searxng', 'spejaren', 'mojeek'])
  })

  test('saves, reads back, and resets', async () => {
    const { policy } = await get()
    policy.fusion = 'rrf'
    policy.providers.spejaren.weight = 2
    expect((await put(policy)).status).toBe(200)

    const saved = await get()
    expect(saved.stored).toBe(true)
    expect(saved.policy.fusion).toBe('rrf')
    expect(saved.policy.providers.spejaren.weight).toBe(2)

    await app.request('/admin/search', { method: 'DELETE', headers: { Cookie: cookie } })
    expect((await get()).stored).toBe(false)
  })

  test('rejects unknown providers and out-of-range values', async () => {
    const { policy } = await get()
    expect((await put({ ...policy, providers: { ...policy.providers, nope: policy.providers.mojeek } })).status).toBe(400)
    expect((await put({ ...policy, rrfK: 0 })).status).toBe(400)
  })
})
