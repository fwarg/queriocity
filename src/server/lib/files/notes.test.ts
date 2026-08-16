/** A note is the one resource whose text the user typed and the app holds nowhere else. These cover
 *  the three ways that text can be lost without anything reporting it: an edit that leaves the old
 *  chunks in place so retrieval answers from a superseded version, a delete that strands the chunks
 *  behind the row, and an embedding reset that takes the note along with the files. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, sqlite, users, uploadedFiles, setAppSetting, resetFileEmbeddings, EMBED_DIMS } = await import('../db.ts')
const { eq } = await import('drizzle-orm')
const { saveNote, reindexNotes } = await import('./notes.ts')
const { searchUploads } = await import('./uploads-search.ts')

let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  // No chat model is stubbed, so summarising would make a call that cannot succeed. It is
  // best-effort and swallows its own failure, but the timeout would make every test slow.
  await setAppSetting('resource_summary', 'false')

  const now = new Date()
  await db.insert(users).values({
    id: 'nu', email: 'nu@example.com', name: null, role: 'user',
    settings: '{}', createdAt: now, updatedAt: now,
  })
})

afterAll(() => {
  server?.stop()
  restoreEnv?.()
})

beforeEach(() => {
  sqlite.run('DELETE FROM file_chunks')
  sqlite.run('DELETE FROM file_chunk_meta')
  sqlite.run('DELETE FROM uploaded_files')
})

const chunkCount = (fileId: string) =>
  (sqlite.query('SELECT count(*) AS n FROM file_chunk_meta WHERE file_id = ?').get(fileId) as { n: number }).n

const chunkText = (fileId: string) =>
  (sqlite.query('SELECT content FROM file_chunk_meta WHERE file_id = ?').all(fileId) as Array<{ content: string }>)
    .map(r => r.content).join('\n')

describe('saveNote', () => {
  test('stores the note as a library resource and indexes its text', async () => {
    const id = await saveNote('nu', { title: 'Migration plan', body: 'We move the ledger to SQLite in March.' })

    const row = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, id)).get()
    // The title is the filename column on purpose — it is the label every citation path reads.
    expect(row?.filename).toBe('Migration plan')
    expect(row?.kind).toBe('note')
    expect(row?.body).toBe('We move the ledger to SQLite in March.')
    // Null hash: two notes may legitimately share a body, and ingestFile's dedup would collapse them.
    expect(row?.contentHash).toBeNull()
    expect(chunkCount(id)).toBeGreaterThan(0)
  })

  test('finds a note through the same search that finds an uploaded file', async () => {
    await saveNote('nu', { title: 'Ledger', body: 'The quarterly ledger reconciliation runs on Fridays.' })

    const hits = await searchUploads('quarterly ledger reconciliation', 'nu')
    expect(hits.map(h => h.filename)).toContain('Ledger')
  })

  test('replaces the old chunks on edit rather than adding beside them', async () => {
    const id = await saveNote('nu', { title: 'Draft', body: 'The deadline is in November.' })
    const before = chunkCount(id)

    await saveNote('nu', { id, title: 'Draft', body: 'The deadline moved to January.' })

    // The failure this guards: retrieval keeps answering "November" from a chunk nothing points to.
    expect(chunkText(id)).toContain('January')
    expect(chunkText(id)).not.toContain('November')
    expect(chunkCount(id)).toBe(before)
  })

  test('does not re-embed a note that was only retitled', async () => {
    const id = await saveNote('nu', { title: 'Old title', body: 'Unchanged content about badgers.' })
    const calls = server.requests.length

    await saveNote('nu', { id, title: 'New title', body: 'Unchanged content about badgers.' })

    const row = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, id)).get()
    expect(row?.filename).toBe('New title')
    expect(server.requests.length).toBe(calls)
  })

  test('refuses a note belonging to someone else', async () => {
    const id = await saveNote('nu', { title: 'Mine', body: 'Private content.' })
    await expect(saveNote('someone-else', { id, title: 'Theirs', body: 'Taken.' })).rejects.toThrow()
  })

  test('refuses an empty title or body', async () => {
    await expect(saveNote('nu', { title: '  ', body: 'text' })).rejects.toThrow()
    await expect(saveNote('nu', { title: 'title', body: '  ' })).rejects.toThrow()
  })
})

describe('an embedding-dimension reset', () => {
  test('clears uploaded files but keeps notes', async () => {
    const noteId = await saveNote('nu', { title: 'Survivor', body: 'This text exists only in the note.' })
    sqlite.run(
      'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)',
      ['f1', 'nu', 'report.pdf', 'application/pdf', 10, 'file', 0],
    )

    resetFileEmbeddings()

    // The file can be uploaded again; the note exists nowhere else, which is the whole distinction.
    expect(await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, 'f1')).get()).toBeUndefined()
    const note = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, noteId)).get()
    expect(note?.body).toBe('This text exists only in the note.')
    expect(chunkCount(noteId)).toBe(0)

    // initSchema recreates the dropped vector table right after; do the same so later tests have one.
    sqlite.run(`CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding FLOAT[${EMBED_DIMS}]
    )`)
  })
})

describe('reindexNotes', () => {
  test('re-embeds a note left without chunks by an embedding reset', async () => {
    const id = await saveNote('nu', { title: 'Survivor', body: 'This text exists only in the note.' })
    sqlite.run('DELETE FROM file_chunks')
    sqlite.run('DELETE FROM file_chunk_meta')
    expect(chunkCount(id)).toBe(0)

    expect(await reindexNotes()).toBe(1)
    expect(chunkText(id)).toContain('exists only in the note')
  })

  test('does nothing when every note is already indexed', async () => {
    await saveNote('nu', { title: 'Indexed', body: 'Already has chunks.' })
    expect(await reindexNotes()).toBe(0)
  })
})
