import { sqlite } from '../db.ts'
import { embedText } from '../embeddings.ts'

export interface ChunkResult {
  chunkId: string
  fileId: string
  content: string
  distance: number
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

  return rows
}
