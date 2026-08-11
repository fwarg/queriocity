import { sqlite } from './db.ts'

/** Deleting rows that own vectors, and sweeping up the vectors nothing owns any more.
 *
 *  The vector tables are `vec0` virtual tables, which cannot carry a foreign key, and two of the
 *  three meta tables have none either (`file_chunk_meta.file_id` is a bare TEXT column). So nothing
 *  in the schema removes a vector when the thing it describes goes away — every deletion path has to
 *  do it explicitly, and any path that forgets leaves debris behind silently.
 *
 *  Orphans are not a correctness bug: every search inner-joins the owning table, so they can never
 *  appear in results. They cost storage and, because sqlite-vec brute-force scans, they are compared
 *  against on every single query for the life of the database. They also keep the *text* of deleted
 *  content in `*_chunk_meta`, which matters for a locked space whose whole promise is that deleting
 *  it destroys what it held. */

/** Remove an uploaded file's chunks and their vectors. Call before deleting the file row. */
export function deleteFileChunks(fileId: string): void {
  sqlite.run(
    'DELETE FROM file_chunks WHERE chunk_id IN (SELECT chunk_id FROM file_chunk_meta WHERE file_id = ?)',
    [fileId],
  )
  sqlite.run('DELETE FROM file_chunk_meta WHERE file_id = ?', [fileId])
}

export interface OrphanCounts {
  fileChunks: number
  chatChunks: number
  memoryVectors: number
}

const countOf = (sql: string): number =>
  (sqlite.query(sql).get() as { n: number } | null)?.n ?? 0

/** Vectors whose owning row is gone, without deleting anything. */
export function countOrphanVectors(): OrphanCounts {
  return {
    fileChunks: countOf(
      'SELECT count(*) AS n FROM file_chunk_meta WHERE file_id NOT IN (SELECT id FROM uploaded_files)',
    ),
    chatChunks: countOf(
      'SELECT count(*) AS n FROM chat_chunk_meta WHERE session_id NOT IN (SELECT id FROM chat_sessions)',
    ),
    memoryVectors: countOf(
      `SELECT count(*) AS n FROM memory_embeddings
       WHERE memory_id NOT IN (SELECT id FROM space_memories)
         AND memory_id NOT IN (SELECT id FROM user_memories)`,
    ),
  }
}

/** Delete every vector and chunk whose owner no longer exists.
 *
 *  Run at startup: the deletion paths are fixed now, but databases that predate the fix carry the
 *  debris, and there is no other moment when a full sweep is cheap. Memory vectors are checked
 *  against *both* memory tables — `memory_embeddings` is keyed by memory id and serves space and
 *  user memories alike, so testing only one would delete the other's vectors. */
export function purgeOrphanVectors(): OrphanCounts {
  const before = countOrphanVectors()
  if (before.fileChunks === 0 && before.chatChunks === 0 && before.memoryVectors === 0) return before

  sqlite.transaction(() => {
    sqlite.run(`DELETE FROM file_chunks WHERE chunk_id IN (
      SELECT chunk_id FROM file_chunk_meta WHERE file_id NOT IN (SELECT id FROM uploaded_files))`)
    sqlite.run('DELETE FROM file_chunk_meta WHERE file_id NOT IN (SELECT id FROM uploaded_files)')

    sqlite.run(`DELETE FROM chat_chunks WHERE chunk_id IN (
      SELECT chunk_id FROM chat_chunk_meta WHERE session_id NOT IN (SELECT id FROM chat_sessions))`)
    sqlite.run('DELETE FROM chat_chunk_meta WHERE session_id NOT IN (SELECT id FROM chat_sessions)')

    sqlite.run(`DELETE FROM memory_embeddings
      WHERE memory_id NOT IN (SELECT id FROM space_memories)
        AND memory_id NOT IN (SELECT id FROM user_memories)`)
  })()

  console.log(`  [vectors] purged orphans — ${before.fileChunks} file chunk(s), ${before.chatChunks} chat chunk(s), ${before.memoryVectors} memory vector(s)`)
  return before
}
