/** The settings PATCH accepts a known theme, stores it alongside the rest, and rejects others. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll } from 'bun:test'
import { Hono } from 'hono'
import { db, users } from '../lib/db.ts'
import { usersRouter } from './users.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'

const app = new Hono().route('/users', usersRouter)
let cookie = ''

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: 'themeu', email: 'themeu@example.com', name: null, role: 'user',
    settings: JSON.stringify({ fontSize: 19 }), tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: 'themeu', email: 'themeu@example.com', role: 'user', tokenVersion: 0 })}`
})

const patch = (body: unknown) => app.request('/users/settings', {
  method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
})

describe('theme setting', () => {
  test('round-trips and keeps the other settings', async () => {
    expect((await patch({ theme: 'eink' })).status).toBe(200)
    const res = await app.request('/users/settings', { headers: { cookie } })
    expect(await res.json()).toMatchObject({ theme: 'eink', fontSize: 19 })
  })

  test('rejects an unknown theme', async () => {
    expect((await patch({ theme: 'sepia' })).status).toBe(400)
  })
})
