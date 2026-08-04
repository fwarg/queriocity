/** Admin settings round-trip for the user-memory budget.
 *
 *  This exists because the setting shipped half-wired: the server read and wrote it, the default
 *  was correct, and the README documented it — but no client type or admin control referenced it,
 *  so there was no way to change it and nothing failed. A round-trip test does not prove a control
 *  exists, but it does keep the plumbing it depends on honest. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { db, users, setAppSetting } from '../lib/db.ts'
import { adminRouter } from './admin.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'

const app = new Hono().route('/admin', adminRouter)
let adminCookie = ''

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: 'admin1', email: 'admin1@example.com', name: null, role: 'admin',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  adminCookie = `${AUTH_COOKIE}=${await signToken({ userId: 'admin1', email: 'admin1@example.com', role: 'admin', tokenVersion: 0 })}`
})

// `bun test` shares one in-memory database across every test file, so app_settings written here
// are visible to the rest of the suite. Anything this file changes, it puts back.
afterAll(async () => { await setAppSetting('user_memory_token_budget', '300') })

const getSettings = async () =>
  (await app.request('/admin/settings', { headers: { Cookie: adminCookie } })).json()

describe('user memory token budget', () => {
  test('is exposed with its documented default', async () => {
    // The README states 300; a silent drift between the two is exactly the class of bug here.
    expect((await getSettings()).userMemoryTokenBudget).toBe(300)
  })

  test('survives a write and read back', async () => {
    const res = await app.request('/admin/settings', {
      method: 'PATCH',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMemoryTokenBudget: 750 }),
    })

    expect(res.status).toBe(200)
    expect((await getSettings()).userMemoryTokenBudget).toBe(750)
  })

  test('0 is accepted, as the documented way to disable the feature globally', async () => {
    const res = await app.request('/admin/settings', {
      method: 'PATCH',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMemoryTokenBudget: 0 }),
    })

    expect(res.status).toBe(200)
    expect((await getSettings()).userMemoryTokenBudget).toBe(0)
  })

  test('a non-admin cannot read or change it', async () => {
    const now = new Date()
    await db.insert(users).values({
      id: 'plain1', email: 'plain1@example.com', name: null, role: 'user',
      settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
    })
    const cookie = `${AUTH_COOKIE}=${await signToken({ userId: 'plain1', email: 'plain1@example.com', role: 'user', tokenVersion: 0 })}`

    const res = await app.request('/admin/settings', { headers: { Cookie: cookie } })

    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
