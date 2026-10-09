import { sqlite } from '../db.ts'
import { rerankScores } from '../reranker.ts'

/** Resources similar in content to a given one, from the chunk vectors already stored for retrieval.
 *
 *  A resource is represented by the mean of its chunk vectors, and its neighbours are the user's
 *  resources whose closest chunk is nearest that mean. When a reranker is configured it then judges
 *  those candidates — a cross-encoder reading both texts tells "same subject" from "same words" far
 *  better than averaged vectors — and cosine similarity is the fallback when there is none or it
 *  fails. It suggests only: nothing is linked or tagged until the user says so. */

/** Chunks averaged into a resource's vector; a long document's first stretch says what it is about. */
const MAX_SOURCE_CHUNKS = 32
/** Nearest chunks fetched; several usually come from one resource, so this exceeds the limit. */
const NEIGHBOUR_CHUNKS = 60
export const RELATED_LIMIT = 6
/** Candidates handed to the reranker: enough that it can promote one cosine ranked low. */
const RERANK_CANDIDATES = 12
const MAX_TAG_HINTS = 5

export interface RelatedResource {
  id: string
  filename: string
  kind: 'file' | 'note'
  /** Already linked either way, or one derived from the other. */
  linked: boolean
  tags: string[]
}

/** The normalised mean of a resource's chunk vectors, or null when it has none indexed. */
export function resourceVector(fileId: string): number[] | null {
  const rows = sqlite.query(`
    SELECT embedding FROM file_chunks
    WHERE chunk_id IN (SELECT chunk_id FROM file_chunk_meta WHERE file_id = ?) LIMIT ?
  `).all(fileId, MAX_SOURCE_CHUNKS) as Array<{ embedding: Uint8Array }>
  if (!rows.length) return null
  const vectors = rows.map(r => asFloats(r.embedding))
  const mean = new Array<number>(vectors[0].length).fill(0)
  for (const v of vectors) for (let i = 0; i < v.length; i++) mean[i] += v[i] / vectors.length
  const norm = Math.hypot(...mean) || 1
  return mean.map(x => x / norm)
}

const asFloats = (blob: Uint8Array) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)

/** Cosine similarity of a unit vector and any vector. Computed here rather than read from vec0's
 *  distance, which is L2 and only equivalent when the embedding model normalises its output. */
function cosine(unit: number[], v: Float32Array): number {
  let dot = 0
  let norm = 0
  for (let i = 0; i < v.length; i++) { dot += unit[i] * v[i]; norm += v[i] * v[i] }
  return norm ? dot / Math.sqrt(norm) : 0
}

/** Resources nearest in content with their cosine similarity, best first. A resource scores by its
 *  closest chunk. Scoped to the user's own chunks through a pushed-down IN, for the reason given on
 *  searchSpaceFiles. */
function nearestResources(userId: string, fileId: string, vector: number[]): Array<[string, number]> {
  const rows = sqlite.query(`
    SELECT m.file_id AS fileId, v.embedding AS embedding FROM file_chunks v
    JOIN file_chunk_meta m ON m.chunk_id = v.chunk_id
    WHERE v.embedding MATCH ? AND k = ?
      AND v.chunk_id IN (
        SELECT m2.chunk_id FROM file_chunk_meta m2 JOIN uploaded_files f2 ON f2.id = m2.file_id
        WHERE f2.user_id = ? AND m2.file_id != ?
      )
    ORDER BY v.distance
  `).all(JSON.stringify(vector), NEIGHBOUR_CHUNKS, userId, fileId) as Array<{ fileId: string; embedding: Uint8Array }>
  const best = new Map<string, number>()
  for (const r of rows) best.set(r.fileId, Math.max(best.get(r.fileId) ?? -1, cosine(vector, asFloats(r.embedding))))
  return [...best].sort((a, b) => b[1] - a[1])
}

/** What the reranker compares: the title and the one-line summary, or the opening excerpt when
 *  there is no summary. */
function describe(id: string): string {
  const row = sqlite.query('SELECT filename, summary FROM uploaded_files WHERE id = ?').get(id) as { filename: string; summary: string | null } | null
  const text = row?.summary
    ?? (sqlite.query('SELECT content FROM file_chunk_meta WHERE file_id = ? LIMIT 1').get(id) as { content: string } | null)?.content
    ?? ''
  return `${row?.filename ?? ''}\n${text}`
}

export interface RelatedThresholds {
  /** Cosine similarity floor, used when no reranker judged the candidates. */
  minSimilarity: number
  /** Reranker relevance floor (0–1). */
  minRelevance: number
}

/** Reranker relevance of the nearest candidates to `fileId`, in candidate order; null when no
 *  reranker judged them. */
async function rerankCandidates(fileId: string, candidates: Array<[string, number]>, floor?: number): Promise<Array<[string, number]> | null> {
  const pool = candidates.slice(0, RERANK_CANDIDATES)
  const scores = pool.length ? await rerankScores(describe(fileId), pool.map(([id]) => describe(id)), floor) : null
  return scores && pool.map(([id], i) => [id, scores[i]])
}

/** The ids to suggest, best first: reranked when possible, else by cosine. */
async function selectRelated(fileId: string, candidates: Array<[string, number]>, t: RelatedThresholds): Promise<string[]> {
  const reranked = await rerankCandidates(fileId, candidates, t.minRelevance)
  if (reranked) {
    return reranked.filter(([, s]) => s >= t.minRelevance)
      .sort((a, b) => b[1] - a[1]).slice(0, RELATED_LIMIT).map(([id]) => id)
  }
  if (candidates.length) console.log(`  [related] similarities: [${candidates.map(([, s]) => s.toFixed(3)).join(', ')}] (min ${t.minSimilarity})`)
  return candidates.filter(([, s]) => s >= t.minSimilarity).slice(0, RELATED_LIMIT).map(([id]) => id)
}

const isConnected = (a: string, b: string) => !!sqlite.query(`
  SELECT 1 FROM resource_links WHERE (src_id = ?1 AND dst_id = ?2) OR (src_id = ?2 AND dst_id = ?1)
  UNION SELECT 1 FROM uploaded_files WHERE (id = ?1 AND derived_from = ?2) OR (id = ?2 AND derived_from = ?1)
`).get(a, b)

const tagsOf = (id: string) => (sqlite.query(
  'SELECT t.path AS path FROM resource_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.resource_id = ? ORDER BY t.path',
).all(id) as Array<{ path: string }>).map(r => r.path)

/** Similar resources, plus the tags several of them share that this one lacks. */
export async function relatedResources(
  userId: string, fileId: string, thresholds: RelatedThresholds = { minSimilarity: 0, minRelevance: 0 },
): Promise<{ related: RelatedResource[]; tags: Array<{ path: string; count: number }> }> {
  const vector = resourceVector(fileId)
  if (!vector) return { related: [], tags: [] }
  const ids = await selectRelated(fileId, nearestResources(userId, fileId, vector), thresholds)
  const related = ids.flatMap(id => {
    const row = sqlite.query('SELECT filename, kind FROM uploaded_files WHERE id = ?').get(id) as { filename: string; kind: 'file' | 'note' } | null
    return row ? [{ id, ...row, linked: isConnected(fileId, id), tags: tagsOf(id) }] : []
  })

  const own = new Set(tagsOf(fileId))
  const counts = new Map<string, number>()
  for (const r of related) for (const tag of r.tags) if (!own.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  const tags = [...counts].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_TAG_HINTS)
    .map(([path, count]) => ({ path, count }))
  return { related, tags }
}

/** Most recent resources scored by the similarity report; each costs one reranker call. */
export const SIMILARITY_REPORT_LIMIT = 40

export interface SimilarityPair {
  from: { id: string; title: string }
  to: { id: string; title: string }
  cosine: number
  /** Null when no reranker judged the pair: it was not among the nearest candidates, or there is
   *  no reranker, or the call failed. */
  relevance: number | null
}

/** Every resource against its nearest neighbours, scored exactly as "Similar content" scores them,
 *  so its thresholds can be calibrated against a real library. Directional: `from` is the resource
 *  being viewed, and a cross-encoder may score the reverse differently. */
export async function similarityReport(userId: string): Promise<{ pairs: SimilarityPair[]; resources: number }> {
  const rows = sqlite.query('SELECT id, filename FROM uploaded_files WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, SIMILARITY_REPORT_LIMIT) as Array<{ id: string; filename: string }>
  const titles = new Map(rows.map(r => [r.id, r.filename]))
  const pairs: SimilarityPair[] = []
  for (const { id, filename } of rows) {
    const vector = resourceVector(id)
    if (!vector) continue
    const candidates = nearestResources(userId, id, vector).filter(([other]) => titles.has(other))
    const relevance = new Map(await rerankCandidates(id, candidates) ?? [])
    for (const [other, cosine] of candidates) {
      pairs.push({ from: { id, title: filename }, to: { id: other, title: titles.get(other)! }, cosine, relevance: relevance.get(other) ?? null })
    }
  }
  pairs.sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || b.cosine - a.cosine)
  return { pairs, resources: rows.length }
}
