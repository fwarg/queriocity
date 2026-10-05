import { randomUUID } from 'crypto'
import { sqlite } from '../db.ts'
import { MAX_TAG_CHARS, normaliseTag, isUnder } from '../../../shared/tags.ts'

/** Tags: the user's own hierarchical labels for what a resource is about (`ml/rag`).
 *
 *  They organise and filter, and nothing else: no retrieval path reads them, so tagging freely can
 *  never change what the model sees. The small model's `topics` are offered as suggestions only.
 *  Synchronous on the bun:sqlite handle so each change runs as one transaction. */

export { MAX_TAG_CHARS, normaliseTag, isUnder }

/** Tag rows nothing carries any more; tags exist only while in use. */
function pruneUnused(userId: string): void {
  sqlite.run('DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM resource_tags)', [userId])
}

function tagId(userId: string, path: string): string {
  const row = sqlite.query('SELECT id FROM tags WHERE user_id = ? AND path = ?').get(userId, path) as { id: string } | null
  if (row) return row.id
  const id = randomUUID()
  sqlite.run('INSERT INTO tags (id, user_id, path) VALUES (?, ?, ?)', [id, userId, path])
  return id
}

/** Replace a resource's tags. The caller has already checked the user owns the resource. */
export function setResourceTags(userId: string, resourceId: string, paths: string[]): string[] {
  const wanted = [...new Set(paths.map(normaliseTag).filter(Boolean))].sort()
  sqlite.transaction(() => {
    sqlite.run('DELETE FROM resource_tags WHERE resource_id = ?', [resourceId])
    for (const path of wanted) {
      sqlite.run('INSERT INTO resource_tags (resource_id, tag_id) VALUES (?, ?)', [resourceId, tagId(userId, path)])
    }
    pruneUnused(userId)
  })()
  return wanted
}

/** Tag paths per resource for one user, for the library list. */
export function tagsByResource(userId: string): Map<string, string[]> {
  const rows = sqlite.query(`
    SELECT rt.resource_id AS resourceId, t.path AS path
    FROM resource_tags rt JOIN tags t ON t.id = rt.tag_id
    WHERE t.user_id = ? ORDER BY t.path
  `).all(userId) as Array<{ resourceId: string; path: string }>
  const out = new Map<string, string[]>()
  for (const r of rows) out.set(r.resourceId, [...(out.get(r.resourceId) ?? []), r.path])
  return out
}

export function resourceTagList(resourceId: string): string[] {
  return (sqlite.query(`
    SELECT t.path AS path FROM resource_tags rt JOIN tags t ON t.id = rt.tag_id
    WHERE rt.resource_id = ? ORDER BY t.path
  `).all(resourceId) as Array<{ path: string }>).map(r => r.path)
}

/** Every tag a user has, with how many resources carry it directly. Parents without a row of their
 *  own are not listed; callers that show a tree derive them from the paths. */
export function listTags(userId: string): Array<{ path: string; count: number }> {
  return sqlite.query(`
    SELECT t.path AS path, COUNT(rt.resource_id) AS count
    FROM tags t JOIN resource_tags rt ON rt.tag_id = t.id
    WHERE t.user_id = ? GROUP BY t.id ORDER BY t.path
  `).all(userId) as Array<{ path: string; count: number }>
}

/** Rename a tag and everything under it (`ml` → `machine-learning` moves `ml/rag` too). Where the new
 *  path already exists the two merge. Returns how many tag rows moved. */
export function renameTag(userId: string, from: string, to: string): number {
  const src = normaliseTag(from)
  const dst = normaliseTag(to)
  if (!src || !dst || src === dst) return 0
  if (isUnder(dst, src)) throw new Error('A tag cannot be moved under itself')
  const moving = (sqlite.query('SELECT id, path FROM tags WHERE user_id = ?').all(userId) as Array<{ id: string; path: string }>)
    .filter(t => isUnder(t.path, src))
  sqlite.transaction(() => {
    for (const t of moving) {
      const target = dst + t.path.slice(src.length)
      const existing = sqlite.query('SELECT id FROM tags WHERE user_id = ? AND path = ?').get(userId, target) as { id: string } | null
      if (existing) {
        sqlite.run('INSERT OR IGNORE INTO resource_tags (resource_id, tag_id) SELECT resource_id, ? FROM resource_tags WHERE tag_id = ?', [existing.id, t.id])
        sqlite.run('DELETE FROM tags WHERE id = ?', [t.id])
      } else {
        sqlite.run('UPDATE tags SET path = ? WHERE id = ?', [target, t.id])
      }
    }
  })()
  return moving.length
}

/** Remove a tag and everything under it from every resource. Returns how many tag rows went. */
export function deleteTag(userId: string, path: string): number {
  const tag = normaliseTag(path)
  if (!tag) return 0
  const ids = (sqlite.query('SELECT id, path FROM tags WHERE user_id = ?').all(userId) as Array<{ id: string; path: string }>)
    .filter(t => isUnder(t.path, tag)).map(t => t.id)
  sqlite.transaction(() => { for (const id of ids) sqlite.run('DELETE FROM tags WHERE id = ?', [id]) })()
  return ids.length
}

/** The small model's topics as tag suggestions: normalised, minus what the resource already carries. */
export function suggestedTags(topics: string[], tags: string[]): string[] {
  const have = new Set(tags)
  return [...new Set(topics.map(normaliseTag).filter(t => t && !have.has(t)))]
}
