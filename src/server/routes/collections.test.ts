/** A collection is a `spaces` row with `kind = 'collection'` — it groups resources and holds no
 *  chats, memories, monitors or lock. Sharing the table is what makes the feature cheap, and also
 *  what makes those invariants only conventions unless something enforces them. These are the
 *  enforcement: every route that attaches something chat-shaped to a space has to say no. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { db, sqlite, users, spaces, chatSessions, uploadedFiles } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { spacesRouter } from './spaces.ts'
import { historyRouter } from './history.ts'
import { monitorsRouter } from './monitors.ts'
import { memoriesRouter } from './memories.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'

const app = new Hono()
  .route('/spaces', spacesRouter)
  .route('/history', historyRouter)
  .route('/monitors', monitorsRouter)
  .route('/spaces', memoriesRouter)

let cookie = ''

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: 'colu', email: 'colu@example.com', name: null, role: 'user',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: 'colu', email: 'colu@example.com', role: 'user', tokenVersion: 0 })}`
})

beforeEach(() => {
  sqlite.run(`DELETE FROM chat_sessions WHERE user_id = 'colu'`)
  sqlite.run(`DELETE FROM spaces WHERE user_id = 'colu'`)
})

const send = (path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const create = async (name: string, kind: 'space' | 'collection') =>
  (await (await send('/spaces', 'POST', { name, kind })).json()) as { id: string; kind: string }

async function seedChat(id: string) {
  const now = new Date()
  await db.insert(chatSessions).values({ id, title: 'A chat', userId: 'colu', spaceId: null, createdAt: now, updatedAt: now })
}

describe('creating', () => {
  test('defaults to a space, so every existing caller is unchanged', async () => {
    const res = await send('/spaces', 'POST', { name: 'Untyped' })
    expect(res.status).toBe(201)
    expect((await res.json()).kind).toBe('space')
  })

  test('reports what a collection holds — resources, not chats', async () => {
    await create('Papers', 'collection')
    const [row] = await (await send('/spaces', 'GET')).json()
    expect({ kind: row.kind, resources: row.resourceCount }).toEqual({ kind: 'collection', resources: 0 })
  })

  test('refuses to create a locked collection', async () => {
    const res = await send('/spaces', 'POST', { name: 'Secret', kind: 'collection', offline: true })
    expect(res.status).toBe(400)
  })
})

describe('a collection holds no chats', () => {
  test('a chat cannot be assigned to one', async () => {
    const collection = await create('Papers', 'collection')
    await seedChat('chat1')

    const res = await send('/history/chat1', 'PATCH', { spaceId: collection.id })
    expect(res.status).toBe(400)
    // The invariant, not merely the response: a 400 that still wrote would be worse than no check.
    const chat = await db.select().from(chatSessions).where(eq(chatSessions.id, 'chat1')).get()
    expect(chat?.spaceId).toBeNull()
  })

  test('a chat can still be assigned to an ordinary space', async () => {
    const space = await create('Thesis', 'space')
    await seedChat('chat2')

    expect((await send('/history/chat2', 'PATCH', { spaceId: space.id })).status).toBe(200)
  })

  test('a monitor cannot be assigned to one', async () => {
    const collection = await create('Papers', 'collection')
    const res = await send('/monitors', 'POST', {
      name: 'Watch', promptText: 'Any news?', intervalMinutes: 1440, spaceId: collection.id,
    })
    expect(res.status).toBe(400)
  })

  test('a memory cannot be written to one', async () => {
    const collection = await create('Papers', 'collection')
    const res = await send(`/spaces/${collection.id}/memories`, 'POST', { content: 'A fact' })
    expect(res.status).toBe(400)
  })
})

describe('a collection cannot be locked', () => {
  test('locking is refused, and the row is unchanged', async () => {
    const collection = await create('Papers', 'collection')
    expect((await send(`/spaces/${collection.id}`, 'PATCH', { offline: true })).status).toBe(400)

    const row = await db.select().from(spaces).where(eq(spaces.id, collection.id)).get()
    expect(row?.offline).toBe(false)
  })

  test('an ordinary space can still be locked', async () => {
    const space = await create('Thesis', 'space')
    expect((await send(`/spaces/${space.id}`, 'PATCH', { offline: true })).status).toBe(200)
  })
})

describe('promotion', () => {
  test('turns a collection into a space and keeps its tagged resources', async () => {
    const collection = await create('Papers', 'collection')
    sqlite.run(
      'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)',
      ['pf1', 'colu', 'paper.pdf', 'application/pdf', 10, 'file', 0],
    )
    sqlite.run('INSERT INTO space_files(space_id, file_id) VALUES (?,?)', [collection.id, 'pf1'])

    expect((await send(`/spaces/${collection.id}`, 'PATCH', { kind: 'space' })).status).toBe(200)

    // Nothing moves: the resources were already in space_files, which is the point of the design.
    const row = await db.select().from(spaces).where(eq(spaces.id, collection.id)).get()
    expect(row?.kind).toBe('space')
    const tags = sqlite.query('SELECT count(*) AS n FROM space_files WHERE space_id = ?').get(collection.id) as { n: number }
    expect(tags.n).toBe(1)
    sqlite.run(`DELETE FROM uploaded_files WHERE id = 'pf1'`)
  })

  test('a promoted collection accepts chats', async () => {
    const collection = await create('Papers', 'collection')
    await send(`/spaces/${collection.id}`, 'PATCH', { kind: 'space' })
    await seedChat('chat3')

    expect((await send('/history/chat3', 'PATCH', { spaceId: collection.id })).status).toBe(200)
  })

  test('a space cannot be demoted', async () => {
    // One-way on purpose: demoting would have to answer what becomes of the chats, memories and
    // lock a space may already hold.
    const space = await create('Thesis', 'space')
    expect((await send(`/spaces/${space.id}`, 'PATCH', { kind: 'collection' })).status).toBe(400)
  })
})

describe('deleting a collection', () => {
  test('removes its tags and leaves the resources themselves alone', async () => {
    const collection = await create('Papers', 'collection')
    sqlite.run(
      'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)',
      ['df1', 'colu', 'paper.pdf', 'application/pdf', 10, 'file', 0],
    )
    sqlite.run('INSERT INTO space_files(space_id, file_id) VALUES (?,?)', [collection.id, 'df1'])

    expect((await send(`/spaces/${collection.id}`, 'DELETE')).status).toBe(200)

    // A collection is a way of grouping resources, not a container that owns them.
    expect(await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, 'df1')).get()).toBeDefined()
    const tags = sqlite.query('SELECT count(*) AS n FROM space_files WHERE space_id = ?').get(collection.id) as { n: number }
    expect(tags.n).toBe(0)
    sqlite.run(`DELETE FROM uploaded_files WHERE id = 'df1'`)
  })
})
