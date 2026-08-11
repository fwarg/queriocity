import './test-support/test-env.ts'
import { describe, expect, it, beforeEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { sqlite } from './db.ts'
import { countOrphanVectors, deleteFileChunks, purgeOrphanVectors } from './vector-cleanup.ts'

/** Nothing in the schema removes a vector when its owner is deleted — vec0 tables cannot carry a
 *  foreign key, and file_chunk_meta has none either. Every deletion path has to do it by hand, and
 *  two of them did not, which is what these tests exist to stop happening again. */

const dim = parseInt(process.env.EMBED_DIMENSIONS ?? '1536', 10)
const vec = () => JSON.stringify(Array(dim).fill(0.01))

function seedFileChunk(fileId: string, chunkId: string) {
  sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)', [chunkId, fileId, 'secret text'])
  sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [chunkId, vec()])
}

function seedChatChunk(sessionId: string, chunkId: string) {
  sqlite.run('INSERT INTO chat_chunk_meta(chunk_id, session_id, content) VALUES (?,?,?)', [chunkId, sessionId, 'secret text'])
  sqlite.run('INSERT INTO chat_chunks(chunk_id, embedding) VALUES (?,?)', [chunkId, vec()])
}

const countIn = (table: string, col: string, id: string) =>
  (sqlite.query(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`).get(id) as { n: number }).n

beforeEach(() => {
  sqlite.run('DELETE FROM file_chunks')
  sqlite.run('DELETE FROM file_chunk_meta')
  sqlite.run('DELETE FROM chat_chunks')
  sqlite.run('DELETE FROM chat_chunk_meta')
  sqlite.run('DELETE FROM memory_embeddings')
})

describe('deleteFileChunks', () => {
  it('removes both the vectors and the stored text', () => {
    const fileId = randomUUID()
    seedFileChunk(fileId, `${fileId}:0`)
    seedFileChunk(fileId, `${fileId}:1`)
    const other = randomUUID()
    seedFileChunk(other, `${other}:0`)

    deleteFileChunks(fileId)

    expect(countIn('file_chunk_meta', 'file_id', fileId)).toBe(0)
    expect(countIn('file_chunks', 'chunk_id', `${fileId}:0`)).toBe(0)
    // Another file's chunks must survive — the delete is scoped by file, not a table wipe.
    expect(countIn('file_chunk_meta', 'file_id', other)).toBe(1)
  })
})

describe('purgeOrphanVectors', () => {
  it('reports and removes chunks whose file no longer exists', () => {
    seedFileChunk('deleted-file-id', 'orphan:0')
    expect(countOrphanVectors().fileChunks).toBe(1)

    purgeOrphanVectors()

    expect(countOrphanVectors().fileChunks).toBe(0)
    expect(countIn('file_chunk_meta', 'chunk_id', 'orphan:0')).toBe(0)
    expect(countIn('file_chunks', 'chunk_id', 'orphan:0')).toBe(0)
  })

  it('removes chat chunks whose session is gone — the locked-space leak', () => {
    seedChatChunk('deleted-session-id', 'chat-orphan:0')
    expect(countOrphanVectors().chatChunks).toBe(1)

    purgeOrphanVectors()

    expect(countOrphanVectors().chatChunks).toBe(0)
    // The text is what mattered: it held the document a locked space was supposed to destroy.
    expect(countIn('chat_chunk_meta', 'chunk_id', 'chat-orphan:0')).toBe(0)
  })

  it('removes memory vectors belonging to no memory', () => {
    sqlite.run('INSERT INTO memory_embeddings(memory_id, embedding) VALUES (?,?)', ['gone', vec()])
    expect(countOrphanVectors().memoryVectors).toBe(1)
    purgeOrphanVectors()
    expect(countOrphanVectors().memoryVectors).toBe(0)
  })

  it('keeps a user memory\'s vector', () => {
    // memory_embeddings is keyed by memory id and serves space *and* user memories. Checking only
    // space_memories for an owner would delete every user memory's vector on the next boot.
    const userId = randomUUID()
    const memoryId = randomUUID()
    const now = Math.floor(Date.now() / 1000)
    sqlite.run('INSERT OR IGNORE INTO users(id, email, role, settings, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [userId, `${userId}@test.invalid`, 'user', '{}', 0, now, now])
    sqlite.run('INSERT INTO user_memories(id, user_id, content, source, always_keep, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [memoryId, userId, 'the user prefers concise answers', 'manual', 0, now, now])
    sqlite.run('INSERT INTO memory_embeddings(memory_id, embedding) VALUES (?,?)', [memoryId, vec()])

    expect(countOrphanVectors().memoryVectors).toBe(0)
    purgeOrphanVectors()
    expect(countIn('memory_embeddings', 'memory_id', memoryId)).toBe(1)

    sqlite.run('DELETE FROM user_memories WHERE id = ?', [memoryId])
    sqlite.run('DELETE FROM users WHERE id = ?', [userId])
  })

  it('is a no-op on a clean database', () => {
    const counts = purgeOrphanVectors()
    expect(counts).toEqual({ fileChunks: 0, chatChunks: 0, memoryVectors: 0 })
  })
})
