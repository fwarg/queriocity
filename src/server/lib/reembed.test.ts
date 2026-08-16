/** Changing EMBED_DIMENSIONS used to delete every uploaded file — and with it the space tags on
 *  those files and any note derived from them. It never had to: the chunk *text* is on disk in
 *  `*_chunk_meta`, and chunk boundaries follow the mime type rather than the model, so only the
 *  vectors are invalid. These cover the recovery, and the property that makes it possible. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from './test-support/fake-embeddings.ts'
import { envOverride } from './test-support/env-override.ts'

const { sqlite, db, users, uploadedFiles, spaceFiles, spaces, resetFileEmbeddings, EMBED_DIMS } = await import('./db.ts')
const { eq } = await import('drizzle-orm')
const { reembedMissingVectors } = await import('./reembed.ts')

let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })

  const now = new Date()
  await db.insert(users).values({
    id: 'ru', email: 'ru@example.com', name: null, role: 'user',
    settings: '{}', createdAt: now, updatedAt: now,
  })
  await db.insert(spaces).values({ id: 'sp', name: 'Research', userId: 'ru', createdAt: now, updatedAt: now })
})

afterAll(() => {
  server?.stop()
  restoreEnv?.()
})

beforeEach(() => {
  sqlite.run('DELETE FROM file_chunks')
  sqlite.run('DELETE FROM file_chunk_meta')
  sqlite.run('DELETE FROM space_files')
  sqlite.run('DELETE FROM uploaded_files')
})

const vec = () => JSON.stringify(Array(EMBED_DIMS).fill(0.01))

/** A stored resource with `chunks` chunks, vectors included, as ingestFile would leave it. */
function seedResource(id: string, filename: string, chunks: string[]) {
  sqlite.run(
    'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, 'ru', filename, 'application/pdf', 100, 'file', 0],
  )
  chunks.forEach((content, i) => {
    sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)', [`${id}:${i}`, id, content])
    sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [`${id}:${i}`, vec()])
  })
}

const vectorCount = () =>
  (sqlite.query('SELECT count(*) AS n FROM file_chunks').get() as { n: number }).n

/** What initSchema does after dropping the table: recreate it at the configured dimension. */
const recreateVectorTable = () => sqlite.run(
  `CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks USING vec0(
    chunk_id TEXT PRIMARY KEY,
    embedding FLOAT[${EMBED_DIMS}]
  )`,
)

describe('an embedding-dimension change', () => {
  test('keeps every resource, its chunk text and its space tags', async () => {
    seedResource('f1', 'annual-report.pdf', ['Revenue grew by twelve percent.', 'Costs held flat.'])
    await db.insert(spaceFiles).values({ spaceId: 'sp', fileId: 'f1' })

    resetFileEmbeddings()
    recreateVectorTable()

    // The row, its text and its tag are the things a user would have to rebuild by hand.
    expect(await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, 'f1')).get()).toBeDefined()
    expect((sqlite.query('SELECT count(*) AS n FROM file_chunk_meta').get() as { n: number }).n).toBe(2)
    expect(await db.select().from(spaceFiles).where(eq(spaceFiles.fileId, 'f1')).get()).toBeDefined()
    // Only the vectors are gone, which is the only thing the new dimension invalidates.
    expect(vectorCount()).toBe(0)
  })

  test('is fully recovered by re-embedding, with no re-chunking and no re-upload', async () => {
    seedResource('f1', 'annual-report.pdf', ['Revenue grew by twelve percent.', 'Costs held flat.'])
    const before = (sqlite.query('SELECT chunk_id AS id, content FROM file_chunk_meta ORDER BY chunk_id').all())

    resetFileEmbeddings()
    recreateVectorTable()

    expect(await reembedMissingVectors()).toBe(2)
    expect(vectorCount()).toBe(2)
    // Chunk boundaries depend on the mime type, not the model, so the text must come back identical
    // — a re-chunk here would silently change what every stored citation points at.
    expect(sqlite.query('SELECT chunk_id AS id, content FROM file_chunk_meta ORDER BY chunk_id').all()).toEqual(before)
  })
})

describe('reembedMissingVectors', () => {
  test('does nothing when every chunk already has a vector', async () => {
    seedResource('f1', 'report.pdf', ['One chunk of text.'])
    expect(await reembedMissingVectors()).toBe(0)
  })

  test('fills in a single chunk whose embedding call failed after its text was stored', async () => {
    seedResource('f1', 'report.pdf', ['First chunk.', 'Second chunk.'])
    sqlite.run('DELETE FROM file_chunks WHERE chunk_id = ?', ['f1:1'])

    expect(await reembedMissingVectors()).toBe(1)
    expect(vectorCount()).toBe(2)
  })

  test('works past one page, so a large corpus is not silently half-done', async () => {
    // PAGE is 200 and the loop re-queries rather than paging by offset; an offset would step over
    // the rows the previous pass removed from the result set and leave most of them unvectorised.
    const chunks = Array.from({ length: 450 }, (_, i) => `Chunk number ${i} of the document.`)
    seedResource('f1', 'big.pdf', chunks)
    sqlite.run('DELETE FROM file_chunks')

    expect(await reembedMissingVectors()).toBe(450)
    expect(vectorCount()).toBe(450)
  })
})
