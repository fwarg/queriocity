import { sqlite } from '../db.ts'
import { tagsByResource } from './tags.ts'
import { createZip, type ZipEntry } from '../zip.ts'

/** A user's library as an Obsidian vault: notes and other resources as markdown files whose names
 *  are their titles, so `[[Title]]` links resolve as they do in the app. Tags, spaces, dates and
 *  provenance go in YAML frontmatter. Flat `Notes/` and `Resources/` folders, since one resource
 *  can sit in several spaces. */

interface Row {
  id: string
  kind: 'note' | 'file'
  title: string
  body: string | null
  summary: string | null
  origin: string | null
  mimeType: string
  derivedFrom: string | null
  originSessionId: string | null
  createdAt: number
  updatedAt: number | null
}

/** Characters a file name cannot hold on some OS, or that Obsidian reads as link syntax. */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g
const MAX_NAME = 120

/** A title as a file name: unsafe characters become spaces, and a clash gets " (2)", " (3)"… */
export function fileNames(titles: string[]): string[] {
  const used = new Set<string>()
  return titles.map(title => {
    const base = title.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Untitled'
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`
    used.add(name.toLowerCase())
    return name
  })
}

/** `[[Title]]` and `[[Title|label]]` pointed at the exported file name where it differs. */
export function relink(body: string, nameOf: Map<string, string>): string {
  return body.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (whole, target: string, label?: string) => {
    const name = nameOf.get(target.trim().toLowerCase())
    if (!name || name === target.trim()) return whole
    return `[[${name}${label ?? `|${target.trim()}`}]]`
  })
}

/** Chunks overlap; each seam's repeated text is dropped when found. */
export function joinChunks(chunks: string[]): string {
  let text = ''
  for (const chunk of chunks) {
    let overlap = 0
    for (let n = Math.min(400, text.length, chunk.length); n >= 20; n--) {
      if (text.endsWith(chunk.slice(0, n))) { overlap = n; break }
    }
    text += text && !overlap ? `\n\n${chunk}` : chunk.slice(overlap)
  }
  return text
}

const yamlString = (s: string) => JSON.stringify(s)
const isoDate = (epochSeconds: number | null) => epochSeconds ? new Date(epochSeconds * 1000).toISOString().slice(0, 10) : undefined

function frontmatter(fields: Record<string, string | string[] | undefined>): string {
  const lines = Object.entries(fields).flatMap(([k, v]) => {
    if (v === undefined || (Array.isArray(v) && !v.length)) return []
    return Array.isArray(v) ? [`${k}:`, ...v.map(x => `  - ${yamlString(x)}`)] : [`${k}: ${yamlString(v)}`]
  })
  return `---\n${lines.join('\n')}\n---\n\n`
}

/** The vault as a zip archive. */
export function exportVault(userId: string): Uint8Array {
  const rows = sqlite.query(`
    SELECT id, kind, filename AS title, body, summary, origin, mime_type AS mimeType, derived_from AS derivedFrom,
           origin_session_id AS originSessionId, created_at AS createdAt, updated_at AS updatedAt
    FROM uploaded_files WHERE user_id = ? ORDER BY created_at
  `).all(userId) as Row[]
  const names = fileNames(rows.map(r => r.title))
  const nameOf = new Map(rows.map((r, i) => [r.title.trim().toLowerCase(), names[i]]))
  const nameById = new Map(rows.map((r, i) => [r.id, names[i]]))
  const tags = tagsByResource(userId)
  const spaces = spacesByResource(userId)
  const chats = chatTitles(userId)
  const encoder = new TextEncoder()

  const entries: ZipEntry[] = rows.map((r, i) => {
    const derived = r.derivedFrom ? nameById.get(r.derivedFrom) : undefined
    const meta = frontmatter({
      aliases: names[i] !== r.title.trim() ? [r.title] : undefined,
      tags: tags.get(r.id),
      spaces: spaces.get(r.id),
      created: isoDate(r.createdAt),
      updated: isoDate(r.updatedAt),
      source: r.origin ?? undefined,
      type: r.kind === 'note' ? undefined : r.mimeType,
      derived_from: derived ? `[[${derived}]]` : undefined,
      saved_from_chat: r.originSessionId ? chats.get(r.originSessionId) : undefined,
      summary: r.kind === 'note' ? undefined : r.summary ?? undefined,
    })
    const text = r.kind === 'note' ? relink(r.body ?? '', nameOf) : joinChunks(chunksOf(r.id))
    const folder = r.kind === 'note' ? 'Notes' : 'Resources'
    return { path: `${folder}/${names[i]}.md`, data: encoder.encode(meta + text + '\n'), modified: new Date((r.updatedAt ?? r.createdAt) * 1000) }
  })
  return createZip(entries)
}

function chunksOf(fileId: string): string[] {
  return (sqlite.query(`
    SELECT content FROM file_chunk_meta WHERE file_id = ?
    ORDER BY CAST(substr(chunk_id, instr(chunk_id, ':') + 1) AS INTEGER)
  `).all(fileId) as Array<{ content: string }>).map(c => c.content)
}

function spacesByResource(userId: string): Map<string, string[]> {
  const rows = sqlite.query(`
    SELECT sf.file_id AS id, s.name FROM space_files sf JOIN spaces s ON s.id = sf.space_id
    JOIN uploaded_files f ON f.id = sf.file_id WHERE f.user_id = ? AND s.user_id = ? ORDER BY s.name
  `).all(userId, userId) as Array<{ id: string; name: string }>
  const out = new Map<string, string[]>()
  for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), r.name])
  return out
}

function chatTitles(userId: string): Map<string, string> {
  return new Map((sqlite.query('SELECT id, title FROM chat_sessions WHERE user_id = ?').all(userId) as Array<{ id: string; title: string }>).map(c => [c.id, c.title]))
}
