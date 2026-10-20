/** Space filtering for GET /api/history.
 *
 *  The bug this guards: the space view used to narrow the *already-fetched* history page client
 *  side. Chat counts are computed over every chat, so a space whose chats fell outside the most
 *  recent page reported "19 chats" and then showed none. The filter has to run server-side, over
 *  the whole table, before the page limit is applied. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll } from 'bun:test'
import { db, users, spaces, chatSessions, messages } from '../lib/db.ts'
import { historyRouter, ftsPrefixQuery } from './history.ts'
import { eq } from 'drizzle-orm'
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

/** /history/search is the one history endpoint built from raw SQL rather than drizzle, so it is
 *  the one that can return the database's column names instead of the API's. It did: `space_id`
 *  reached a client reading `spaceId`, and every searched chat looked like it belonged to no
 *  space — no padlock on a locked chat, unlocked spaces offered as move targets for it, and the
 *  next message posted without a spaceId, silently dropping space memory and RAG. */
describe('GET /history/search', () => {
  test('returns the space association under the name the client reads', async () => {
    const res = await app.request(`/history/search?q=old chat 1`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const items = await res.json() as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)

    const hit = items.find(i => i.id === 'old-1')
    expect(hit).toBeDefined()
    expect(hit!.spaceId).toBe(OLD_SPACE)
    // The shape the type promises, not the table's.
    expect(hit).not.toHaveProperty('space_id')
  })

  test('still orders by recency after the columns were aliased', async () => {
    // The ORDER BY had to be renamed along with the columns. SQLite turned out to accept the old
    // `cs.updated_at` against the aliased output too, so this pins the ordering rather than the
    // parse — recency is what makes the result list usable.
    const res = await app.request(`/history/search?q=old chat`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const items = await res.json() as Array<{ updatedAt: number }>
    const times = items.map(i => i.updatedAt)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  test('treats % and _ in the query as literal characters', async () => {
    // Unescaped, `_` matches any one character and `%` anything, so both would hit every chat.
    for (const q of ['old_chat', 'old%chat']) {
      const res = await app.request(`/history/search?q=${encodeURIComponent(q)}`, { headers: { cookie } })
      expect(await res.json()).toEqual([])
    }
  })
})

describe('GET /history/search over message content', () => {
  const search = async (q: string) => {
    const res = await app.request(`/history/search?q=${encodeURIComponent(q)}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    return (await res.json() as Array<{ id: string }>).map(i => i.id)
  }

  beforeAll(async () => {
    const now = new Date()
    await db.insert(messages).values([
      { id: 'fts-1', sessionId: 'old-0', role: 'assistant', content: 'Honungen från Åre lagras i kallt förråd.', createdAt: now },
      { id: 'fts-2', sessionId: 'old-1', role: 'user', content: 'Where does the post office open?', createdAt: now },
    ])
  })

  test('matches word prefixes regardless of case, Å and å alike', async () => {
    expect(await search('honung')).toEqual(['old-0'])
    expect(await search('ÅRE KALL')).toEqual(['old-0'])
  })

  test('matches the start of a word, not a fragment inside one', async () => {
    expect(await search('ost')).toEqual([])
    expect(await search('pos')).toEqual(['old-1'])
  })

  test('reads FTS syntax in the query as plain words', async () => {
    expect(await search('"post* (office')).toEqual(['old-1'])
  })

  test('forgets a message once it is deleted', async () => {
    await db.delete(messages).where(eq(messages.id, 'fts-2'))
    expect(await search('post')).toEqual([])
  })
})

describe('ftsPrefixQuery', () => {
  test('quotes each word as a prefix and drops punctuation', () => {
    expect(ftsPrefixQuery('bee* "hive" OR')).toBe('"bee"* "hive"* "OR"*')
    expect(ftsPrefixQuery('%_ -')).toBeNull()
  })
})
