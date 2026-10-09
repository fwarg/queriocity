import { sqlite } from '../db.ts'
import { tagsByResource } from './tags.ts'
import { createZip, type ZipEntry } from '../zip.ts'
import { imageFilePath, imageUrlsIn } from '../image-store.ts'

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

/** The vault as a zip archive. `full` adds every chat as a markdown file and the generated images
 *  the chats show; notes saved from a chat then link to it. Originals of uploads are not kept by
 *  the app, so files are always their extracted text. */
export async function exportVault(userId: string, { full = false } = {}): Promise<Uint8Array> {
  const rows = sqlite.query(`
    SELECT id, kind, filename AS title, body, summary, origin, mime_type AS mimeType, derived_from AS derivedFrom,
           origin_session_id AS originSessionId, created_at AS createdAt, updated_at AS updatedAt
    FROM uploaded_files WHERE user_id = ? ORDER BY created_at
  `).all(userId) as Row[]
  const sessions = full ? chatRows(userId) : []
  // One namespace for everything: Obsidian resolves [[Name]] by file name across folders.
  const names = fileNames([...rows.map(r => r.title), ...sessions.map(c => c.title)])
  const chatName = new Map(sessions.map((c, i) => [c.id, names[rows.length + i]]))
  const entries = resourceEntries(userId, rows, names.slice(0, rows.length), chatName)
  if (full) entries.push(...chatEntries(sessions, chatName), ...await imageEntries(userId, sessions))
  return createZip(entries)
}

const encoder = new TextEncoder()

function resourceEntries(userId: string, rows: Row[], names: string[], chatName: Map<string, string>): ZipEntry[] {
  const nameOf = new Map(rows.map((r, i) => [r.title.trim().toLowerCase(), names[i]]))
  const nameById = new Map(rows.map((r, i) => [r.id, names[i]]))
  const tags = tagsByResource(userId)
  const spaces = spacesByResource(userId)
  const chats = chatTitles(userId)
  return rows.map((r, i) => {
    const derived = r.derivedFrom ? nameById.get(r.derivedFrom) : undefined
    const linkedChat = r.originSessionId ? chatName.get(r.originSessionId) : undefined
    const meta = frontmatter({
      aliases: names[i] !== r.title.trim() ? [r.title] : undefined,
      tags: tags.get(r.id),
      spaces: spaces.get(r.id),
      created: isoDate(r.createdAt),
      updated: isoDate(r.updatedAt),
      source: r.origin ?? undefined,
      type: r.kind === 'note' ? undefined : r.mimeType,
      derived_from: derived ? `[[${derived}]]` : undefined,
      saved_from_chat: linkedChat ? `[[${linkedChat}]]` : r.originSessionId ? chats.get(r.originSessionId) : undefined,
      summary: r.kind === 'note' ? undefined : r.summary ?? undefined,
    })
    const text = r.kind === 'note' ? relink(r.body ?? '', nameOf) : joinChunks(chunksOf(r.id))
    const folder = r.kind === 'note' ? 'Notes' : 'Resources'
    return { path: `${folder}/${names[i]}.md`, data: encoder.encode(meta + text + '\n'), modified: new Date((r.updatedAt ?? r.createdAt) * 1000) }
  })
}

interface ChatRow { id: string; title: string; space: string | null; createdAt: number; updatedAt: number }
interface MessageRow { role: 'user' | 'assistant'; content: string; sources: string | null }

function chatRows(userId: string): ChatRow[] {
  return sqlite.query(`
    SELECT c.id, c.title, s.name AS space, c.created_at AS createdAt, c.updated_at AS updatedAt
    FROM chat_sessions c LEFT JOIN spaces s ON s.id = c.space_id WHERE c.user_id = ? ORDER BY c.created_at
  `).all(userId) as ChatRow[]
}

/** Generated images are referenced by their app URL; in the vault they sit in `Images/`. */
const IMAGE_LINK = /\(\/images\/[\w-]+\/([\w-]+\.png)\)/g

/** One chat as markdown: each turn under a heading, an answer's sources listed below it. */
export function chatMarkdown(chat: ChatRow, messages: MessageRow[]): string {
  const meta = frontmatter({ title: chat.title, created: isoDate(chat.createdAt), updated: isoDate(chat.updatedAt), space: chat.space ?? undefined })
  const turns = messages.map(m => {
    const body = m.content.replace(IMAGE_LINK, '(../Images/$1)')
    const sources = m.sources ? (JSON.parse(m.sources) as Array<{ title?: string; url: string }>) : []
    const list = sources.length ? `\n\n${sources.map((src, i) => `- **[${i + 1}]** [${src.title || src.url}](${src.url})`).join('\n')}` : ''
    return `## ${m.role === 'user' ? 'You' : 'Assistant'}\n\n${body.trim()}${list}`
  })
  return meta + turns.join('\n\n')
}

function chatEntries(sessions: ChatRow[], chatName: Map<string, string>): ZipEntry[] {
  return sessions.map(chat => {
    const messages = sqlite.query('SELECT role, content, sources FROM messages WHERE session_id = ? ORDER BY created_at')
      .all(chat.id) as MessageRow[]
    return { path: `Chats/${chatName.get(chat.id)}.md`, data: encoder.encode(chatMarkdown(chat, messages) + '\n'), modified: new Date(chat.updatedAt * 1000) }
  })
}

/** The generated images the user's chats show, read from the image store; a missing file is skipped. */
async function imageEntries(userId: string, sessions: ChatRow[]): Promise<ZipEntry[]> {
  if (!sessions.length) return []
  const contents = (sqlite.query(`
    SELECT m.content FROM messages m JOIN chat_sessions c ON c.id = m.session_id WHERE c.user_id = ?
  `).all(userId) as Array<{ content: string }>).map(m => m.content)
  const entries: ZipEntry[] = []
  for (const url of imageUrlsIn(contents)) {
    const path = imageFilePath(userId, url)
    if (!path) continue
    const file = Bun.file(path)
    if (await file.exists()) entries.push({ path: `Images/${url.split('/').pop()}`, data: new Uint8Array(await file.arrayBuffer()) })
  }
  return entries
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
