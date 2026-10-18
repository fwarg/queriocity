import { sqlite } from '../db.ts'
import { tagsByResource } from './tags.ts'
import { createZip, type ZipEntry } from '../zip.ts'
import { imageFilePath, imageUrlsIn } from '../image-store.ts'
import { linkTarget, okfBody, okfFields, okfIndexes, type PathByTitle } from './okf-export.ts'

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
  generatedBy: string | null
  verifiedAt: number | null
  status: string | null
  createdAt: number
  updatedAt: number | null
}

/** Characters a file name cannot hold on some OS, or that Obsidian reads as link syntax. */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g
const MAX_NAME = 120

/** OKF's reserved file names, kept free of resources in an OKF export. */
const OKF_RESERVED = ['index', 'log']

const safeName = (title: string) => title.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Untitled'

/** A title as a file name: unsafe characters become spaces, and a clash (with another title or a
 *  `reserved` name) gets " (2)", " (3)"… */
export function fileNames(titles: string[], reserved: string[] = []): string[] {
  const used = new Set(reserved)
  return titles.map(title => {
    const base = safeName(title)
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

/** Strings and string lists in block style; anything else (OKF's mappings) as JSON, which YAML reads. */
function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).flatMap(([k, v]) => {
    if (v === undefined || (Array.isArray(v) && !v.length)) return []
    if (typeof v === 'string') return [`${k}: ${yamlString(v)}`]
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return [`${k}:`, ...v.map(x => `  - ${yamlString(x)}`)]
    return [`${k}: ${JSON.stringify(v)}`]
  })
  return `---\n${lines.join('\n')}\n---\n\n`
}

/** The vault as a zip archive. `full` adds every chat as a markdown file and the generated images
 *  the chats show; notes saved from a chat then link to it. `okf` writes the OKF flavour (see
 *  okf-export.ts). Originals of uploads are not kept by the app, so files are always their
 *  extracted text. */
export async function exportVault(userId: string, { full = false, okf = false } = {}): Promise<Uint8Array> {
  const rows = sqlite.query(`
    SELECT id, kind, filename AS title, body, summary, origin, mime_type AS mimeType, derived_from AS derivedFrom,
           origin_session_id AS originSessionId, generated_by AS generatedBy, verified_at AS verifiedAt, status,
           created_at AS createdAt, updated_at AS updatedAt
    FROM uploaded_files WHERE user_id = ? ORDER BY created_at
  `).all(userId) as Row[]
  const sessions = full ? chatRows(userId) : []
  // One namespace for everything: Obsidian resolves [[Name]] by file name across folders.
  const names = fileNames([...rows.map(r => r.title), ...sessions.map(c => c.title)], okf ? OKF_RESERVED : [])
  const chatName = new Map(sessions.map((c, i) => [c.id, names[rows.length + i]]))
  const resourceNames = names.slice(0, rows.length)
  const entries = resourceEntries(userId, rows, resourceNames, chatName, okf ? ownerActor(userId) : null)
  if (full) entries.push(...chatEntries(sessions, chatName, okf), ...await imageEntries(userId, sessions))
  if (okf) entries.push(...indexEntries(rows, resourceNames, sessions, chatName))
  return createZip(entries)
}

const folderOf = (r: Pick<Row, 'kind'>) => r.kind === 'note' ? 'Notes' : 'Resources'

/** The user as an OKF actor id: their name, else a neutral "owner" (never the e-mail address). */
function ownerActor(userId: string): string {
  const user = sqlite.query('SELECT name FROM users WHERE id = ?').get(userId) as { name: string | null } | null
  return user?.name?.trim().replace(/\s+/g, '-') || 'owner'
}

function indexEntries(rows: Row[], names: string[], sessions: ChatRow[], chatName: Map<string, string>): ZipEntry[] {
  const items = [
    ...rows.map((r, i) => ({ folder: folderOf(r), name: names[i], title: r.title, description: r.summary ?? undefined })),
    ...sessions.map(c => ({ folder: 'Chats', name: chatName.get(c.id)!, title: c.title })),
  ]
  return okfIndexes(items).map(({ path, text }) => ({ path, data: encoder.encode(text) }))
}

const encoder = new TextEncoder()

/** `okfOwner` set means the OKF flavour, naming the user in its actors. */
function resourceEntries(userId: string, rows: Row[], names: string[], chatName: Map<string, string>, okfOwner: string | null): ZipEntry[] {
  const nameOf = new Map(rows.map((r, i) => [r.title.trim().toLowerCase(), names[i]]))
  const paths: PathByTitle = new Map(rows.map((r, i) => [r.title.trim().toLowerCase(), `${folderOf(r)}/${names[i]}.md`]))
  const nameById = new Map(rows.map((r, i) => [r.id, names[i]]))
  const pathById = new Map(rows.map((r, i) => [r.id, `${folderOf(r)}/${names[i]}.md`]))
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
      // OKF claims `type` for the kind of concept, so the MIME type moves aside there.
      [okfOwner ? 'mime_type' : 'type']: r.kind === 'note' ? undefined : r.mimeType,
      derived_from: derived ? (okfOwner ? linkTarget(pathById.get(r.derivedFrom!)!) : `[[${derived}]]`) : undefined,
      saved_from_chat: linkedChat ? (okfOwner ? linkTarget(`Chats/${linkedChat}.md`) : `[[${linkedChat}]]`) : r.originSessionId ? chats.get(r.originSessionId) : undefined,
      summary: r.kind === 'note' || okfOwner ? undefined : r.summary ?? undefined,
      ...(okfOwner ? okfFields(r, r.body ?? '', okfOwner, paths) : {}),
    })
    const text = r.kind !== 'note' ? joinChunks(chunksOf(r.id))
      : okfOwner ? okfBody(r.body ?? '', paths, safeName) : relink(r.body ?? '', nameOf)
    return { path: `${folderOf(r)}/${names[i]}.md`, data: encoder.encode(meta + text + '\n'), modified: new Date((r.updatedAt ?? r.createdAt) * 1000) }
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

/** One chat as markdown: each turn under a heading, an answer's sources listed below it. `okf` adds
 *  the `type` every OKF concept needs. */
export function chatMarkdown(chat: ChatRow, messages: MessageRow[], okf = false): string {
  const meta = frontmatter({ type: okf ? 'Chat' : undefined, title: chat.title, created: isoDate(chat.createdAt), updated: isoDate(chat.updatedAt), space: chat.space ?? undefined })
  const turns = messages.map(m => {
    const body = m.content.replace(IMAGE_LINK, '(../Images/$1)')
    const sources = m.sources ? (JSON.parse(m.sources) as Array<{ title?: string; url: string }>) : []
    const list = sources.length ? `\n\n${sources.map((src, i) => `- **[${i + 1}]** [${src.title || src.url}](${src.url})`).join('\n')}` : ''
    return `## ${m.role === 'user' ? 'You' : 'Assistant'}\n\n${body.trim()}${list}`
  })
  return meta + turns.join('\n\n')
}

function chatEntries(sessions: ChatRow[], chatName: Map<string, string>, okf: boolean): ZipEntry[] {
  return sessions.map(chat => {
    const messages = sqlite.query('SELECT role, content, sources FROM messages WHERE session_id = ? ORDER BY created_at')
      .all(chat.id) as MessageRow[]
    return { path: `Chats/${chatName.get(chat.id)}.md`, data: encoder.encode(chatMarkdown(chat, messages, okf) + '\n'), modified: new Date(chat.updatedAt * 1000) }
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
