import { sqlite } from '../db.ts'

/** `[[wikilinks]]` between a user's resources.
 *
 *  A link names its target by title — the resource's `filename`, which the user sees and renames —
 *  and is stored resolved to an id, so the link survives the target being renamed. Matching is
 *  case-insensitive in JS rather than SQL: SQLite's lower() folds ASCII only, and titles are often
 *  Swedish. */

export interface LinkRef { id: string; filename: string; kind: 'file' | 'note' }
export interface OutgoingLink { title: string; target: LinkRef | null }

const WIKILINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g

/** Text with code removed, so `[[x]]` inside a code sample is not a link. */
const withoutCode = (body: string) => body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

/** The distinct titles a body links to, in order of first appearance. */
export function parseWikilinks(body: string): string[] {
  const seen = new Set<string>()
  const titles: string[] = []
  for (const m of withoutCode(body).matchAll(WIKILINK)) {
    const title = m[1].trim()
    const key = title.toLowerCase()
    if (title && !seen.has(key)) {
      seen.add(key)
      titles.push(title)
    }
  }
  return titles
}

const fold = (title: string) => title.trim().toLowerCase()

/** title (folded) → id of the user's oldest resource with that title. */
function titleIndex(userId: string): Map<string, string> {
  const rows = sqlite.query('SELECT id, filename FROM uploaded_files WHERE user_id = ? ORDER BY created_at')
    .all(userId) as Array<{ id: string; filename: string }>
  const index = new Map<string, string>()
  for (const r of rows) if (!index.has(fold(r.filename))) index.set(fold(r.filename), r.id)
  return index
}

/** Rebuild a note's outgoing links from its body. */
export function syncLinks(userId: string, noteId: string, body: string): void {
  const index = titleIndex(userId)
  sqlite.transaction(() => {
    sqlite.run('DELETE FROM resource_links WHERE src_id = ?', [noteId])
    for (const title of parseWikilinks(body)) {
      const dst = index.get(fold(title))
      sqlite.run('INSERT INTO resource_links (src_id, dst_id, dst_title) VALUES (?, ?, ?)', [noteId, dst === noteId ? null : dst ?? null, title])
    }
  })()
}

/** Point the user's dangling links at a resource that now carries their title (created or renamed). */
export function resolveDangling(userId: string, resourceId: string, title: string): void {
  const rows = sqlite.query(`
    SELECT rl.rowid AS rowid, rl.dst_title AS title, rl.src_id AS src FROM resource_links rl
    JOIN uploaded_files f ON f.id = rl.src_id
    WHERE f.user_id = ? AND rl.dst_id IS NULL
  `).all(userId) as Array<{ rowid: number; title: string; src: string }>
  for (const r of rows) {
    if (r.src !== resourceId && fold(r.title) === fold(title)) {
      sqlite.run('UPDATE resource_links SET dst_id = ? WHERE rowid = ?', [resourceId, r.rowid])
    }
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Bodies of the user's notes that link to `resourceId`, with `[[oldTitle]]` rewritten to
 *  `[[newTitle]]` (aliases kept). The caller saves them; only changed bodies are returned. */
export function bodiesRelinkedTo(userId: string, resourceId: string, oldTitle: string, newTitle: string): Array<{ id: string; title: string; body: string }> {
  const sources = sqlite.query(`
    SELECT DISTINCT f.id AS id, f.filename AS title, f.body AS body FROM resource_links rl
    JOIN uploaded_files f ON f.id = rl.src_id
    WHERE rl.dst_id = ? AND f.user_id = ? AND f.kind = 'note'
  `).all(resourceId, userId) as Array<{ id: string; title: string; body: string | null }>
  const pattern = new RegExp(`\\[\\[\\s*${escapeRegExp(oldTitle.trim())}\\s*(\\|[^\\[\\]\\n]*)?\\]\\]`, 'gi')
  return sources.flatMap(s => {
    const body = (s.body ?? '').replace(pattern, (_m, alias: string | undefined) => `[[${newTitle}${alias ?? ''}]]`)
    return body !== s.body ? [{ id: s.id, title: s.title, body }] : []
  })
}

/** What a resource links to (notes only have outgoing links) and what links to it. */
export function linksOf(userId: string, resourceId: string): { links: OutgoingLink[]; backlinks: LinkRef[] } {
  const out = sqlite.query(`
    SELECT rl.dst_title AS title, f.id AS id, f.filename AS filename, f.kind AS kind
    FROM resource_links rl LEFT JOIN uploaded_files f ON f.id = rl.dst_id AND f.user_id = ?
    WHERE rl.src_id = ? ORDER BY rl.rowid
  `).all(userId, resourceId) as Array<{ title: string; id: string | null; filename: string | null; kind: 'file' | 'note' | null }>
  const backlinks = sqlite.query(`
    SELECT DISTINCT f.id AS id, f.filename AS filename, f.kind AS kind FROM resource_links rl
    JOIN uploaded_files f ON f.id = rl.src_id
    WHERE rl.dst_id = ? AND f.user_id = ? ORDER BY f.filename
  `).all(resourceId, userId) as LinkRef[]
  return {
    links: out.map(o => ({ title: o.title, target: o.id ? { id: o.id, filename: o.filename!, kind: o.kind! } : null })),
    backlinks,
  }
}

/** `body` with `item` added under its `## heading` section, creating the section at the end when
 *  missing. The item goes after the section's last non-blank line, before any following heading. */
export function addUnderHeading(body: string, heading: string, item: string): string {
  const lines = body.trimEnd().split('\n')
  const start = lines.findIndex(l => l.trim() === `## ${heading}`)
  if (start === -1) return `${lines.join('\n')}\n\n## ${heading}\n\n${item}\n`
  let end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l))
  if (end === -1) end = lines.length
  while (end - 1 > start && !lines[end - 1].trim()) end--
  const at = end === start + 1 ? ['', item] : [item]
  lines.splice(end, 0, ...at)
  return `${lines.join('\n')}\n`
}
