import { sqlite } from '../db.ts'
import { embedText } from '../embeddings.ts'
import { rerank, rerankEnabled } from '../reranker.ts'

export interface ChunkResult {
  chunkId: string
  fileId: string
  filename: string
  content: string
  distance: number
}

/** Returns true if the space has any tagged files — cheap check before embedding. */
export function spaceHasTaggedFiles(spaceId: string): boolean {
  const row = sqlite.prepare('SELECT 1 FROM space_files WHERE space_id = ? LIMIT 1').get(spaceId)
  return row !== undefined
}

/** Search file chunks for a space using a pre-computed embedding vector.
 *
 *  Scoping goes in an `IN (SELECT ...)` on the vec0 primary key, not a JOIN predicate: sqlite-vec
 *  applies `k` *before* joined-table filters, so `... JOIN space_files ... AND k = 5` asks for the
 *  5 nearest chunks in the whole database and only then keeps this space's — which returns nothing
 *  at all once other spaces hold enough closer chunks. A pushed-down `IN` makes `k` mean "k nearest
 *  within this space", which is what every caller assumes. */
export async function searchSpaceFiles(spaceId: string, query: string, embedding: number[], limit = 5, skipRerank = false, fileIds?: string[]): Promise<ChunkResult[]> {
  const fileFilter = fileIds?.length
    ? `AND m2.file_id IN (${fileIds.map(() => '?').join(',')})`
    : ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [JSON.stringify(embedding), limit, spaceId, ...(fileIds ?? [])]
  const rows = sqlite.prepare(`
    SELECT m.chunk_id AS chunkId, m.file_id AS fileId, f.filename, m.content, v.distance
    FROM file_chunks v
    JOIN file_chunk_meta m ON m.chunk_id = v.chunk_id
    JOIN uploaded_files f  ON f.id = m.file_id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND v.chunk_id IN (
        SELECT m2.chunk_id FROM file_chunk_meta m2
        JOIN space_files sf ON sf.file_id = m2.file_id
        WHERE sf.space_id = ?
        ${fileFilter}
      )
    ORDER BY v.distance
  `).all(...params) as ChunkResult[]

  if (skipRerank || !rerankEnabled || rows.length === 0) return rows
  const indices = await rerank(query, rows.map(r => r.content), rows.length)
  return indices.map(i => rows[i])
}

export async function searchUploads(query: string, userId: string, limit = 5): Promise<ChunkResult[]> {
  const embedding = await embedText(query)
  const embeddingJson = JSON.stringify(embedding)

  // Ownership is scoped through a pushed-down IN rather than a JOIN predicate — see the note on
  // searchSpaceFiles. With a JOIN filter, one user's chunks crowd every other user out of `k`.
  const rows = sqlite.prepare(`
    SELECT m.chunk_id AS chunkId, m.file_id AS fileId, f.filename, m.content, v.distance
    FROM file_chunks v
    JOIN file_chunk_meta m ON m.chunk_id = v.chunk_id
    JOIN uploaded_files f  ON f.id = m.file_id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND v.chunk_id IN (
        SELECT m2.chunk_id FROM file_chunk_meta m2
        JOIN uploaded_files f2 ON f2.id = m2.file_id
        WHERE f2.user_id = ?
      )
    ORDER BY v.distance
  `).all(embeddingJson, limit, userId) as ChunkResult[]

  if (!rerankEnabled || rows.length === 0) return rows
  const indices = await rerank(query, rows.map(r => r.content), rows.length)
  return indices.map(i => rows[i])
}
