/** Ingest has to be all-or-nothing, because an uploaded file's text exists nowhere but its chunks.
 *
 *  The failure these were written for: an ingest that threw while embedding left its row behind with
 *  a content hash, and the retry matched that hash and returned the empty row instantly — reported
 *  as success, with no excerpts and no way to recover but deleting it by hand. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, sqlite, users, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { ingestFile } = await import('./ingest.ts')

let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

const DOCUMENT = 'The quarterly report covers revenue, costs and the outlook for the coming year. '.repeat(40)
const asBuffer = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  await setAppSetting('resource_summary', 'false')

  const now = new Date()
  await db.insert(users).values({
    id: 'iu', email: 'iu@example.com', name: null, role: 'user',
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

const rowCount = () =>
  (sqlite.query('SELECT count(*) AS n FROM uploaded_files').get() as { n: number }).n

describe('ingestFile', () => {
  test('stores the document with its chunks', async () => {
    const id = await ingestFile(asBuffer(DOCUMENT), 'report.txt', 'text/plain', 'iu')
    expect(chunkCount(id)).toBeGreaterThan(0)
  })

  test('returns the same resource for identical content rather than a duplicate', async () => {
    const first = await ingestFile(asBuffer(DOCUMENT), 'report.txt', 'text/plain', 'iu')
    const second = await ingestFile(asBuffer(DOCUMENT), 'report-copy.txt', 'text/plain', 'iu')
    expect(second).toBe(first)
    expect(rowCount()).toBe(1)
  })

  test('leaves nothing behind when indexing fails', async () => {
    await expect(server.whileFailing(() =>
      ingestFile(asBuffer(DOCUMENT), 'report.txt', 'text/plain', 'iu'),
    )).rejects.toThrow()

    // A file is nothing without its chunks, and a surviving row would also keep its content hash —
    // which is what made the retry below silently return an empty resource.
    expect(rowCount()).toBe(0)
  })

  test('a retry after a failed ingest produces a working resource', async () => {
    await server.whileFailing(() =>
      ingestFile(asBuffer(DOCUMENT), 'report.txt', 'text/plain', 'iu').catch(() => {}),
    )

    const id = await ingestFile(asBuffer(DOCUMENT), 'report.txt', 'text/plain', 'iu')
    expect(chunkCount(id)).toBeGreaterThan(0)
  })

  test('re-ingests over a resource stranded without chunks by an earlier version', async () => {
    // The row a user is left holding today: right hash, no excerpts. Dedup must not treat it as a
    // completed upload, or the resource can never be repaired from the UI.
    const stranded = 'stranded-id'
    const { createHash } = await import('crypto')
    const hash = createHash('sha256').update(Buffer.from(asBuffer(DOCUMENT))).digest('hex')
    sqlite.run(
      'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, content_hash, kind, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [stranded, 'iu', 'report.txt', 'text/plain', 100, hash, 'file', 0],
    )

    const id = await ingestFile(asBuffer(DOCUMENT), 'report.txt', 'text/plain', 'iu')

    expect(id).not.toBe(stranded)
    expect(chunkCount(id)).toBeGreaterThan(0)
    expect(rowCount()).toBe(1)
  })
})
