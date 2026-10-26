import { sqlite } from '../db.ts'
import { embedText } from '../embeddings.ts'
import { rerank, rerankEnabled } from '../reranker.ts'
import { ragTopK, ragMinSimilarity } from '../rag-settings.ts'
import { withoutConfidential, confidentialSql, trackingLeftOut, noteLeftOut } from './confidential.ts'

export interface ChunkResult {
  chunkId: string
  fileId: string
  filename: string
  content: string
  distance: number
  /** Cosine similarity to the query vector, computed rather than derived from `distance`, which is
   *  L2 and only equivalent when the embedding model normalises its output. */
  similarity: number
}

/** The rows at or above `floor`, with their similarities logged — the scores, not just the counts,
 *  so the floor can be picked from what this embedding model actually produces. A floor of 0 keeps
 *  everything and logs nothing. The embedding-only stand-in for a reranker's relevance floor. */
export function aboveSimilarity<T extends { similarity: number }>(rows: T[], floor: number, label: string): T[] {
  if (floor <= 0 || !rows.length) return rows
  const kept = rows.filter(r => r.similarity >= floor)
  console.log(`  [${label}] similarities: [${rows.map(r => r.similarity.toFixed(3)).join(', ')}] (floor ${floor}) → ${kept.length}/${rows.length} kept`)
  return kept
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
export async function searchSpaceFiles(spaceId: string, query: string, embedding: number[], limit?: number, skipRerank = false, fileIds?: string[], minScore?: number, includeConfidential = false): Promise<ChunkResult[]> {
  const topK = limit ?? await ragTopK()
  const fileFilter = fileIds?.length
    ? `AND m2.file_id IN (${fileIds.map(() => '?').join(',')})`
    : ''
  const scope = `SELECT m2.chunk_id FROM file_chunk_meta m2
        JOIN space_files sf ON sf.file_id = m2.file_id
        WHERE sf.space_id = ? ${fileFilter}`
  const params = [spaceId, ...(fileIds ?? [])]
  const rows = nearestChunks(JSON.stringify(embedding), topK, scope, params, 'm2.file_id', includeConfidential)

  if (skipRerank || !rerankEnabled() || rows.length === 0) return rows
  const indices = await rerank(query, rows.map(r => r.content), rows.length, minScore)
  return indices.map(i => rows[i])
}

/** `kind` limits the search to the user's notes, or to everything else (files and pages).
 *  Confidential resources are left out unless the turn is locked (`includeConfidential`).
 *  `minScore` is the reranker's floor; given without a reranker, rag_min_similarity applies instead. */
export async function searchUploads(query: string, userId: string, limit?: number, minScore?: number, kind?: 'note' | 'file', includeConfidential = false): Promise<ChunkResult[]> {
  const topK = limit ?? await ragTopK()
  const embedding = await embedText(query, 'query')

  // Ownership is scoped through a pushed-down IN rather than a JOIN predicate — see the note on
  // searchSpaceFiles. With a JOIN filter, one user's chunks crowd every other user out of `k`.
  const scope = `SELECT m2.chunk_id FROM file_chunk_meta m2
        JOIN uploaded_files f2 ON f2.id = m2.file_id
        WHERE f2.user_id = ?${kind ? ' AND f2.kind = ?' : ''}`
  const rows = nearestChunks(JSON.stringify(embedding), topK, scope, [userId, ...(kind ? [kind] : [])], 'm2.file_id', includeConfidential)

  if (rows.length === 0) return rows
  // A caller passing a relevance floor wants weak matches kept out; without a reranker to judge
  // them, the similarity floor does that instead.
  if (!rerankEnabled()) return minScore == null ? rows : aboveSimilarity(rows, await ragMinSimilarity(), 'uploads')
  const indices = await rerank(query, rows.map(r => r.content), rows.length, minScore)
  return indices.map(i => rows[i])
}

/** The `k` chunks of one resource nearest the embedding — for spreading a search across documents. */
export function searchFile(fileId: string, embedding: number[], k: number, includeConfidential = false): ChunkResult[] {
  return nearestChunks(JSON.stringify(embedding), k, 'SELECT m2.chunk_id FROM file_chunk_meta m2 WHERE m2.file_id = ?', [fileId], 'm2.file_id', includeConfidential)
}

/** The `topK` chunks nearest the embedding within `scope` (a subquery selecting chunk ids; `fileCol`
 *  names its file id column). Without `includeConfidential`, confidential resources are left out,
 *  and those that would have been among the results are recorded for the turn (noteLeftOut). */
function nearestChunks(embeddingJson: string, topK: number, scope: string, params: string[], fileCol: string, includeConfidential: boolean): ChunkResult[] {
  const run = (filter: string) => sqlite.prepare(`
    SELECT m.chunk_id AS chunkId, m.file_id AS fileId, f.filename, m.content, v.distance,
      1 - vec_distance_cosine(v.embedding, ?) AS similarity
    FROM file_chunks v
    JOIN file_chunk_meta m ON m.chunk_id = v.chunk_id
    JOIN uploaded_files f  ON f.id = m.file_id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND v.chunk_id IN (${scope} ${filter})
    ORDER BY v.distance
  `).all(embeddingJson, embeddingJson, topK, ...params) as ChunkResult[]
  const rows = run(withoutConfidential(fileCol, includeConfidential))
  if (!includeConfidential && trackingLeftOut()) {
    // Close enough to have made the cut: nearer than the farthest kept result, or any when fewer were kept.
    const cutoff = rows.length < topK ? Infinity : rows[rows.length - 1].distance
    noteLeftOut(run(`AND ${confidentialSql(fileCol)}`).filter(r => r.distance <= cutoff).map(r => r.fileId))
  }
  return rows
}
