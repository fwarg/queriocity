import { sqlite } from '../db.ts'

/** Resources similar in content to a given one, from the chunk vectors already stored for retrieval.
 *
 *  A resource is represented by the mean of its chunk vectors, and its neighbours are the user's
 *  resources whose closest chunk is nearest that mean. No model call, so it is cheap enough to show
 *  on every detail view. It suggests only: nothing is linked or tagged until the user says so. */

/** Chunks averaged into a resource's vector; a long document's first stretch says what it is about. */
const MAX_SOURCE_CHUNKS = 32
/** Nearest chunks fetched; several usually come from one resource, so this exceeds the limit. */
const NEIGHBOUR_CHUNKS = 60
export const RELATED_LIMIT = 6
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
function resourceVector(fileId: string): number[] | null {
  const rows = sqlite.query(`
    SELECT embedding FROM file_chunks
    WHERE chunk_id IN (SELECT chunk_id FROM file_chunk_meta WHERE file_id = ?) LIMIT ?
  `).all(fileId, MAX_SOURCE_CHUNKS) as Array<{ embedding: Uint8Array }>
  if (!rows.length) return null
  const vectors = rows.map(r => new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4))
  const mean = new Array<number>(vectors[0].length).fill(0)
  for (const v of vectors) for (let i = 0; i < v.length; i++) mean[i] += v[i] / vectors.length
  const norm = Math.hypot(...mean) || 1
  return mean.map(x => x / norm)
}

/** Resource ids nearest in content, best first. Scoped to the user's own chunks through a
 *  pushed-down IN, for the reason given on searchSpaceFiles. */
function nearestResources(userId: string, fileId: string, vector: number[]): string[] {
  const rows = sqlite.query(`
    SELECT m.file_id AS fileId FROM file_chunks v
    JOIN file_chunk_meta m ON m.chunk_id = v.chunk_id
    WHERE v.embedding MATCH ? AND k = ?
      AND v.chunk_id IN (
        SELECT m2.chunk_id FROM file_chunk_meta m2 JOIN uploaded_files f2 ON f2.id = m2.file_id
        WHERE f2.user_id = ? AND m2.file_id != ?
      )
    ORDER BY v.distance
  `).all(JSON.stringify(vector), NEIGHBOUR_CHUNKS, userId, fileId) as Array<{ fileId: string }>
  return [...new Set(rows.map(r => r.fileId))].slice(0, RELATED_LIMIT)
}

const isConnected = (a: string, b: string) => !!sqlite.query(`
  SELECT 1 FROM resource_links WHERE (src_id = ?1 AND dst_id = ?2) OR (src_id = ?2 AND dst_id = ?1)
  UNION SELECT 1 FROM uploaded_files WHERE (id = ?1 AND derived_from = ?2) OR (id = ?2 AND derived_from = ?1)
`).get(a, b)

const tagsOf = (id: string) => (sqlite.query(
  'SELECT t.path AS path FROM resource_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.resource_id = ? ORDER BY t.path',
).all(id) as Array<{ path: string }>).map(r => r.path)

/** Similar resources, plus the tags several of them share that this one lacks. */
export function relatedResources(userId: string, fileId: string): { related: RelatedResource[]; tags: Array<{ path: string; count: number }> } {
  const vector = resourceVector(fileId)
  if (!vector) return { related: [], tags: [] }
  const related = nearestResources(userId, fileId, vector).flatMap(id => {
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
