/** The memory HTTP surface for provenance: `sources` and `checked_at` ride through the GET/POST/
 *  PATCH round-trip, the content cap moved to 600, and a hand-edit clears the verification stamp
 *  without touching the source links. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { db, users, spaces, spaceMemories } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { memoriesRouter } from './memories.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'

const app = new Hono().route('/spaces', memoriesRouter)

let cookie = ''

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: 'provu', email: 'provu@example.com', name: null, role: 'user',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  await db.insert(spaces).values({ id: 'provs', name: 'provs', userId: 'provu', createdAt: now, updatedAt: now })
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: 'provu', email: 'provu@example.com', role: 'user', tokenVersion: 0 })}`
})

beforeEach(async () => {
  await db.delete(spaceMemories).where(eq(spaceMemories.spaceId, 'provs'))
})

const send = (path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

describe('memory provenance over HTTP', () => {
  test('a hand-added memory has no sources and no checked_at', async () => {
    const res = await send('/spaces/provs/memories', 'POST', { content: 'A manual note' })
    expect(res.status).toBe(201)
    const row = await res.json()
    expect(row.sources).toBeNull()
    expect(row.checkedAt).toBeNull()
  })

  test('the content cap is 600 characters', async () => {
    expect((await send('/spaces/provs/memories', 'POST', { content: 'x'.repeat(600) })).status).toBe(201)
    expect((await send('/spaces/provs/memories', 'POST', { content: 'x'.repeat(601) })).status).toBe(400)
  })

  test('GET returns stored sources as an array and checked_at as an integer', async () => {
    const now = new Date()
    await db.insert(spaceMemories).values({
      id: 'pm1', spaceId: 'provs', content: 'A finding', source: 'extraction', sessionId: null,
      sources: [{ url: 'https://x.example', title: 'X' }], checkedAt: 1_700_000_000,
      createdAt: now, updatedAt: now,
    })

    const { memories } = await (await send('/spaces/provs/memories', 'GET')).json()
    const row = memories.find((m: { id: string }) => m.id === 'pm1')
    expect(row.sources).toEqual([{ url: 'https://x.example', title: 'X' }])
    expect(row.checkedAt).toBe(1_700_000_000)
  })

  test('editing the text clears checked_at but keeps the source links', async () => {
    const now = new Date()
    await db.insert(spaceMemories).values({
      id: 'pm2', spaceId: 'provs', content: 'Old wording', source: 'extraction', sessionId: null,
      sources: [{ url: 'https://y.example', title: 'Y' }], checkedAt: 1_700_000_000,
      createdAt: now, updatedAt: now,
    })

    expect((await send('/spaces/provs/memories/pm2', 'PATCH', { content: 'New wording' })).status).toBe(200)

    const row = await db.select().from(spaceMemories).where(eq(spaceMemories.id, 'pm2')).get()
    expect(row?.content).toBe('New wording')
    expect(row?.checkedAt).toBeNull()
    expect(row?.sources).toEqual([{ url: 'https://y.example', title: 'Y' }])
  })

  test('toggling always-keep leaves checked_at intact', async () => {
    const now = new Date()
    await db.insert(spaceMemories).values({
      id: 'pm3', spaceId: 'provs', content: 'Keep me', source: 'extraction', sessionId: null,
      sources: [{ url: 'https://z.example', title: 'Z' }], checkedAt: 1_700_000_000,
      createdAt: now, updatedAt: now,
    })

    expect((await send('/spaces/provs/memories/pm3', 'PATCH', { alwaysKeep: true })).status).toBe(200)

    const row = await db.select().from(spaceMemories).where(eq(spaceMemories.id, 'pm3')).get()
    expect(row?.checkedAt).toBe(1_700_000_000)
  })
})
