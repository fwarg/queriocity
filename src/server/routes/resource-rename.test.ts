/** Renaming a resource, through the route the UI actually calls.
 *
 *  A `filename` here is a title, not a path: an uploaded file arrives named by whoever made it and a
 *  URL by its address, neither reliably descriptive. Because that column is also the label every
 *  retrieval citation carries, renaming has to reach later answers — and must not disturb the chunks
 *  the vectors were built from, which describe content a rename does not touch. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { startFakeEmbeddings } from '../lib/test-support/fake-embeddings.ts'
import { envOverride } from '../lib/test-support/env-override.ts'
import { db, sqlite, users, uploadedFiles, EMBED_DIMS } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { embedText } from '../lib/embeddings.ts'
import { searchUploads } from '../lib/files/uploads-search.ts'
import { filesRouter } from './files.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'

const app = new Hono().route('/files', filesRouter)
const OWNER = 'rename-owner'
const STRANGER = 'rename-stranger'

let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void
let cookie = ''

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })

  const now = new Date()
  for (const id of [OWNER, STRANGER]) {
    await db.insert(users).values({
      id, email: `${id}@rename.test`, name: null, role: 'user',
      settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
    })
  }
  cookie = `${AUTH_COOKIE}=${await signToken({ userId: OWNER, email: `${OWNER}@rename.test`, role: 'user', tokenVersion: 0 })}`
})

afterAll(() => { server?.stop(); restoreEnv?.() })

beforeEach(() => {
  sqlite.run('DELETE FROM file_chunks')
  sqlite.run('DELETE FROM file_chunk_meta')
  sqlite.run('DELETE FROM uploaded_files')
})

const rename = (id: string, filename: string) =>
  app.request(`/files/${id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  })

/** An ingested URL, named the way ingest names one, with a searchable chunk. */
async function seedResource(id: string, filename: string, content: string, userId = OWNER) {
  sqlite.run(
    'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, userId, filename, 'text/plain', content.length, 'file', 0],
  )
  sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)', [`${id}:0`, id, content])
  sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)',
    [`${id}:0`, JSON.stringify(await embedText(content))])
}

const nameOf = async (id: string) =>
  (await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, id)).get())?.filename

describe('renaming a resource', () => {
  test('renames an uploaded file or ingested URL, not only a note', async () => {
    await seedResource('r1', 'github.com/lfnovo/open-notebook', 'An open source Notebook LM alternative.')

    expect((await rename('r1', 'Open Notebook — project page')).status).toBe(200)
    expect(await nameOf('r1')).toBe('Open Notebook — project page')
  })

  test('trims surrounding whitespace', async () => {
    await seedResource('r1', 'report_final_v3.pdf', 'Quarterly figures and commentary.')
    await rename('r1', '  Q3 report  ')
    expect(await nameOf('r1')).toBe('Q3 report')
  })

  test('refuses an empty name, leaving the old one', async () => {
    await seedResource('r1', 'keep.pdf', 'Some content.')
    expect((await rename('r1', '   ')).status).toBe(400)
    expect(await nameOf('r1')).toBe('keep.pdf')
  })

  test('refuses a resource belonging to someone else', async () => {
    await seedResource('r1', 'theirs.pdf', 'Private content.', STRANGER)

    expect((await rename('r1', 'Mine now')).status).toBe(404)
    // The 404 must be the whole story: a refused rename that still wrote would be worse than none.
    expect(await nameOf('r1')).toBe('theirs.pdf')
  })

  test('reaches the citations in later answers', async () => {
    await seedResource('r1', 'v3-final', 'The quarterly ledger reconciliation runs on Fridays.')
    await rename('r1', 'Ledger schedule')

    // The filename is read live at search time rather than stored beside the chunk, which is what
    // makes a rename show up in answers quoting a resource indexed long before.
    const hits = await searchUploads('quarterly ledger reconciliation', OWNER)
    expect(hits.map(h => h.filename)).toContain('Ledger schedule')
  })

  test('leaves the origin alone — the title is renameable, the source is not', async () => {
    // The whole reason `origin` exists: renaming used to erase the only record of where an ingested
    // page came from, and `filename` was already a lossy label rather than the address.
    sqlite.run(
      'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, origin, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ['r2', OWNER, 'github.com/lfnovo/open-notebook', 'text/plain', 20, 'file', 'https://github.com/lfnovo/open-notebook', 0],
    )

    await rename('r2', 'Open Notebook — project page')

    const row = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, 'r2')).get()
    expect(row?.filename).toBe('Open Notebook — project page')
    expect(row?.origin).toBe('https://github.com/lfnovo/open-notebook')
  })

  test('does not re-embed: the vectors describe content a rename leaves alone', async () => {
    await seedResource('r1', 'before.pdf', 'The content stays exactly as it was.')
    const chunksBefore = sqlite.query('SELECT content FROM file_chunk_meta WHERE file_id = ?').all('r1')
    const calls = server.requests.length

    await rename('r1', 'after.pdf')

    expect(sqlite.query('SELECT content FROM file_chunk_meta WHERE file_id = ?').all('r1')).toEqual(chunksBefore)
    expect(server.requests.length).toBe(calls)
  })
})
