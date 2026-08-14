/** Deleting a user has to take the data the schema cannot reach.
 *
 *  `db.delete(users)` cascades every table with a foreign key, and none of the ones that matter
 *  most have one: `chat_chunk_meta` and `file_chunk_meta` hold a verbatim copy of the
 *  conversations and documents, and the vec0 tables beside them cannot carry an FK at all. So the
 *  account vanished from the UI while its text stayed in the database until a restart happened to
 *  run purgeOrphanVectors. The chat, file and space delete routes each do this cleanup already;
 *  this one did not. */

import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  db, sqlite, users, spaces, spaceMemories, userMemories, chatSessions, messages, uploadedFiles,
} from '../lib/db.ts'
import { adminRouter } from './admin.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'
import { Hono } from 'hono'

const app = new Hono().route('/admin', adminRouter)
const dim = parseInt(process.env.EMBED_DIMENSIONS ?? '1536', 10)
const vec = () => JSON.stringify(Array(dim).fill(0.01))
const countIn = (table: string, col: string, id: string) =>
  (sqlite.query(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`).get(id) as { n: number }).n

const ADMIN = 'admin-del'
let cookie = ''

/** A user with one chat, one indexed chunk of it, one uploaded file with a chunk, a space memory
 *  and a user memory — one row in every table the cascade cannot reach. */
async function seedVictim() {
  const id = `victim-${randomUUID()}`
  const now = new Date()
  await db.insert(users).values({
    id, email: `${id}@example.invalid`, name: null, role: 'user',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  const spaceId = `sp-${id}`
  await db.insert(spaces).values({ id: spaceId, name: 's', userId: id, createdAt: now, updatedAt: now })

  const sessionId = `se-${id}`
  await db.insert(chatSessions).values({ id: sessionId, title: 't', userId: id, spaceId, createdAt: now, updatedAt: now })
  await db.insert(messages).values({ id: randomUUID(), sessionId, role: 'user', content: 'the confidential question', createdAt: now })
  sqlite.run('INSERT INTO chat_chunk_meta(chunk_id, session_id, content) VALUES (?,?,?)',
    [`${sessionId}:0`, sessionId, 'the confidential question'])
  sqlite.run('INSERT INTO chat_chunks(chunk_id, embedding) VALUES (?,?)', [`${sessionId}:0`, vec()])

  const fileId = `fi-${id}`
  await db.insert(uploadedFiles).values({
    id: fileId, userId: id, filename: 'contract.pdf', mimeType: 'application/pdf',
    size: 1, createdAt: now,
  })
  sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)',
    [`${fileId}:0`, fileId, 'the confidential document'])
  sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [`${fileId}:0`, vec()])

  const spaceMemoryId = `sm-${id}`
  await db.insert(spaceMemories).values({
    id: spaceMemoryId, spaceId, sessionId, content: 'a fact', source: 'tool', createdAt: now, updatedAt: now,
  })
  const userMemoryId = `um-${id}`
  await db.insert(userMemories).values({
    id: userMemoryId, userId: id, content: 'a preference', source: 'manual', createdAt: now, updatedAt: now,
  })
  for (const mid of [spaceMemoryId, userMemoryId]) {
    sqlite.run('INSERT INTO memory_embeddings(memory_id, embedding) VALUES (?,?)', [mid, vec()])
  }

  return { id, sessionId, fileId, spaceMemoryId, userMemoryId }
}

beforeEach(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: ADMIN, email: 'admin-del@example.invalid', name: null, role: 'admin',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  }).onConflictDoNothing()
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: ADMIN, email: 'admin-del@example.invalid', role: 'admin', tokenVersion: 0 })}`
})

describe('DELETE /admin/users/:id', () => {
  test('leaves nothing of the account behind', async () => {
    const v = await seedVictim()

    const res = await app.request(`/admin/users/${v.id}`, { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(200)

    // The cascade's own work.
    expect(await db.select().from(users).where(eq(users.id, v.id)).get()).toBeUndefined()
    // Everything it cannot reach — the text first, since that is the part that leaked.
    expect(countIn('chat_chunk_meta', 'session_id', v.sessionId)).toBe(0)
    expect(countIn('chat_chunks', 'chunk_id', `${v.sessionId}:0`)).toBe(0)
    expect(countIn('file_chunk_meta', 'file_id', v.fileId)).toBe(0)
    expect(countIn('file_chunks', 'chunk_id', `${v.fileId}:0`)).toBe(0)
    expect(countIn('memory_embeddings', 'memory_id', v.spaceMemoryId)).toBe(0)
    expect(countIn('memory_embeddings', 'memory_id', v.userMemoryId)).toBe(0)
  })

  test('touches nobody else', async () => {
    const [victim, bystander] = [await seedVictim(), await seedVictim()]

    await app.request(`/admin/users/${victim.id}`, { method: 'DELETE', headers: { cookie } })

    expect(countIn('chat_chunk_meta', 'session_id', bystander.sessionId)).toBe(1)
    expect(countIn('file_chunk_meta', 'file_id', bystander.fileId)).toBe(1)
    expect(countIn('memory_embeddings', 'memory_id', bystander.userMemoryId)).toBe(1)
    expect(await db.select().from(users).where(eq(users.id, bystander.id)).get()).toBeDefined()
  })
})
