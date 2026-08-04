/** Space filtering for GET /api/history.
 *
 *  The bug this guards: the space view used to narrow the *already-fetched* history page client
 *  side. Chat counts are computed over every chat, so a space whose chats fell outside the most
 *  recent page reported "19 chats" and then showed none. The filter has to run server-side, over
 *  the whole table, before the page limit is applied. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll } from 'bun:test'
import { db, users, spaces, chatSessions } from '../lib/db.ts'
import { historyRouter } from './history.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'
import { Hono } from 'hono'

const USER = 'hu1'
const OLD_SPACE = 'space-old'
const PAGE = 50

const app = new Hono().route('/history', historyRouter)
let cookie = ''

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: USER, email: 'hu1@example.com', name: null, role: 'user',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  await db.insert(spaces).values({ id: OLD_SPACE, name: 'old', userId: USER, createdAt: now, updatedAt: now })

  // Three chats in the space, updated long ago...
  for (let i = 0; i < 3; i++) {
    const t = new Date(Date.now() - 400 * 24 * 3600 * 1000 + i * 1000)
    await db.insert(chatSessions).values({
      id: `old-${i}`, title: `old chat ${i}`, userId: USER, spaceId: OLD_SPACE,
      createdAt: t, updatedAt: t, graduated: 0,
    })
  }
  // ...buried under more than a full page of newer, space-less chats.
  for (let i = 0; i < PAGE + 10; i++) {
    const t = new Date(Date.now() - i * 1000)
    await db.insert(chatSessions).values({
      id: `new-${i}`, title: `recent chat ${i}`, userId: USER, spaceId: null,
      createdAt: t, updatedAt: t, graduated: 0,
    })
  }

  cookie = `${AUTH_COOKIE}=${await signToken({ userId: USER, email: 'hu1@example.com', role: 'user', tokenVersion: 0 })}`
})

const get = (path: string) => app.request(path, { headers: { Cookie: cookie } })

describe('GET /history?spaceId', () => {
  test('the space\'s chats are absent from the first unfiltered page', async () => {
    const { items } = await (await get('/history')).json()

    // Precondition for the bug: this is exactly what the old client-side filter had to work with.
    expect(items).toHaveLength(PAGE)
    expect(items.some((s: { spaceId: string | null }) => s.spaceId === OLD_SPACE)).toBe(false)
  })

  test('filtering by spaceId returns them regardless of how old they are', async () => {
    const { items, total } = await (await get(`/history?spaceId=${OLD_SPACE}`)).json()

    expect(items).toHaveLength(3)
    expect(total).toBe(3)
    expect(items.every((s: { spaceId: string | null }) => s.spaceId === OLD_SPACE)).toBe(true)
  })

  test('another user cannot read chats in a space they do not own', async () => {
    const now = new Date()
    await db.insert(users).values({
      id: 'hu2', email: 'hu2@example.com', name: null, role: 'user',
      settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
    })
    const other = await signToken({ userId: 'hu2', email: 'hu2@example.com', role: 'user', tokenVersion: 0 })

    // The spaceId filter is additive to the existing user scoping, never a replacement for it.
    const res = await app.request(`/history?spaceId=${OLD_SPACE}`, {
      headers: { Cookie: `${AUTH_COOKIE}=${other}` },
    })

    expect(res.status).toBe(200)
    expect((await res.json()).items).toHaveLength(0)
  })
})
