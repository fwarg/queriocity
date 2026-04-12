import { sqlite } from '../db.ts'
import { embedText } from '../embeddings.ts'
import { rerank, rerankEnabled } from '../reranker.ts'

export interface ChunkResult {
  chunkId: string
  fileId: string
  content: string
  distance: number
}

/** Returns true if the space has any tagged files — cheap check before embedding. */
export function spaceHasTaggedFiles(spaceId: string): boolean {
  const row = sqlite.prepare('SELECT 1 FROM space_files WHERE space_id = ? LIMIT 1').get(spaceId)
  return row !== undefined
}

/** Search file chunks for a space using a pre-computed embedding vector. */
export async function searchSpaceFiles(spaceId: string, query: string, embedding: number[], limit = 5, skipRerank = false): Promise<ChunkResult[]> {
  const rows = sqlite.prepare(`
    SELECT m.chunk_id, m.file_id, m.content, v.distance
    FROM file_chunks v
    JOIN file_chunk_meta m ON m.chunk_id = v.chunk_id
    JOIN space_files sf    ON sf.file_id = m.file_id
    WHERE v.embedding MATCH ?
      AND sf.space_id = ?
      AND k = ?
    ORDER BY v.distance
  `).all(JSON.stringify(embedding), spaceId, limit) as ChunkResult[]

  if (skipRerank || !rerankEnabled || rows.length === 0) return rows
  const indices = await rerank(query, rows.map(r => r.content), rows.length)
  return indices.map(i => rows[i])
}

export async function searchUploads(query: string, userId: string, limit = 5): Promise<ChunkResult[]> {
  const embedding = await embedText(query)
  const embeddingJson = JSON.stringify(embedding)

  // sqlite-vec KNN query joined with metadata + user ownership check
  const rows = sqlite.prepare(`
    SELECT m.chunk_id, m.file_id, m.content, v.distance
    FROM file_chunks v
    JOIN file_chunk_meta m ON m.chunk_id = v.chunk_id
    JOIN uploaded_files f  ON f.id = m.file_id
    WHERE v.embedding MATCH ?
      AND f.user_id = ?
      AND k = ?
    ORDER BY v.distance
  `).all(embeddingJson, userId, limit) as ChunkResult[]

  if (!rerankEnabled || rows.length === 0) return rows
  const indices = await rerank(query, rows.map(r => r.content), rows.length)
  return indices.map(i => rows[i])
}
