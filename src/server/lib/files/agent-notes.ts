import { eq } from 'drizzle-orm'
import { db, sqlite, uploadedFiles } from '../db.ts'
import { saveNote } from './notes.ts'
import { noteRevisions, recordRevision } from './note-revisions.ts'
import { HUMAN_AUTHOR } from '../../../shared/note-trust.ts'
import { wikilinkFor } from '../../../shared/wikilinks.ts'

/** Notes an agent writes: always marked as the model's and a draft, always citing the documents
 *  they came from, and never written over anything the user wrote or reviewed. An agent may rework
 *  its own unreviewed drafts; the version it replaces is kept, so the change can be undone. */

export interface AgentNoteInput {
  title: string
  body: string
  /** The writing model's label. */
  model: string
  /** Cited labels (`C1`) to document titles; a note must cite at least one. */
  documents: Map<string, string>
  /** Cited labels to resource ids, recorded as the documents the note was saved from. */
  documentIds?: Map<string, string>
  /** Web results the run numbered [1]…, citable beside the documents (never instead of them). */
  web?: Array<{ title: string; url: string }>
  /** The heading over the sources list, in the user's language. */
  sourcesHeading: string
  /** Written from confidential material: the note is confidential too. */
  confidential: boolean
}

export type AgentNoteOutcome =
  | { kind: 'created' | 'updated'; id: string; title: string }
  /** A note of that title is the user's (or reviewed): saved under another title, linking to it. */
  | { kind: 'alongside'; id: string; title: string; existing: string }
  | { kind: 'refused'; reason: string }

interface Existing { id: string; title: string; kind: string; body: string | null; generatedBy: string | null; verifiedAt: number | null }

export async function saveAgentNote(userId: string, input: AgentNoteInput): Promise<AgentNoteOutcome> {
  const title = input.title.trim()
  const cited = [...new Set([...input.body.matchAll(/\[(C\d+)\]/g)].map(m => m[1]))].filter(l => input.documents.has(l))
  if (!title || !input.body.trim()) return { kind: 'refused', reason: 'A note needs a title and some text.' }
  if (!cited.length) return { kind: 'refused', reason: 'A note must cite the documents it comes from, by label (e.g. [C1]).' }
  const web = citedWeb(input.body.trim(), input.web ?? [])
  const sources = [...cited.sort(byLabel).map(l => `- **[${l}]** ${input.documents.get(l)}`), ...web.sources].join('\n')
  const body = `${web.body}\n\n---\n\n## ${input.sourcesHeading}\n\n${sources}`

  const existing = byTitle(userId, title)
  // Beside a note the user owns, the draft saved there last time is the one to rework.
  const draft = existing && !isOwnDraft(existing) ? byTitle(userId, draftTitle(title)) : existing
  if (draft && isOwnDraft(draft)) {
    recordRevision(draft.id, draft.title, draft.body ?? '', input.model)
    const kept = draft === existing ? title : draft.title
    await saveNote(userId, { id: draft.id, title: kept, body: draft === existing ? body : withSeeAlso(body, existing!.title) })
    markConfidential(draft.id, input.confidential)
    recordDocuments(draft.id, cited, input.documentIds)
    return { kind: 'updated', id: draft.id, title: kept }
  }
  const named = existing ? freeTitle(userId, draftTitle(title)) : title
  const id = await saveNote(userId, {
    title: named,
    body: existing ? withSeeAlso(body, existing.title) : body,
    author: 'model', model: input.model, status: 'draft',
  })
  markConfidential(id, input.confidential)
  recordDocuments(id, cited, input.documentIds)
  return existing ? { kind: 'alongside', id, title: named, existing: existing.title } : { kind: 'created', id, title: named }
}

/** Replaces the documents recorded for a note with those it now cites. */
function recordDocuments(noteId: string, cited: string[], ids: Map<string, string> | undefined) {
  if (!ids) return
  sqlite.run('DELETE FROM agent_note_documents WHERE note_id = ?', [noteId])
  for (const label of cited) {
    const fileId = ids.get(label)
    if (fileId) sqlite.run('INSERT OR IGNORE INTO agent_note_documents (note_id, file_id) VALUES (?, ?)', [noteId, fileId])
  }
}

/** The model's notes saved from a document, newest first: its mark that notes were saved. */
export function notesSavedFrom(fileId: string): Array<{ id: string; filename: string; kind: string; origin: string | null; generatedBy: string | null; createdAt: number }> {
  return sqlite.query(`
    SELECT f.id, f.filename, f.kind, f.origin, f.generated_by AS generatedBy, f.created_at AS createdAt
    FROM agent_note_documents d JOIN uploaded_files f ON f.id = d.note_id
    WHERE d.file_id = ? ORDER BY f.created_at DESC, f.filename
  `).all(fileId) as Array<{ id: string; filename: string; kind: string; origin: string | null; generatedBy: string | null; createdAt: number }>
}

const byTitle = (userId: string, title: string) => sqlite.query(`
  SELECT id, filename AS title, kind, body, generated_by AS generatedBy, verified_at AS verifiedAt
  FROM uploaded_files WHERE user_id = ? AND lower(filename) = lower(?)
`).get(userId, title) as Existing | null

const draftTitle = (title: string) => `${title} (draft)`
const withSeeAlso = (body: string, title: string) => `${body}\n\nSee also: ${wikilinkFor(title)}`

/** A model's note the user has not reviewed: the only kind an agent may rewrite. */
const isOwnDraft = (n: Existing) => n.kind === 'note' && !!n.generatedBy && n.generatedBy !== HUMAN_AUTHOR && n.verifiedAt === null

/** A bare `[3]`, as note-citations.ts reads one: not a wikilink, source label, or link. */
const WEB_MARKER = /(?<![[\\*])\[(\d+)\](?![\](:])/g

/** The web results a note cites, renumbered [1]… in order of first citation, as a note saved from
 *  an answer numbers them. A number naming no result is left as written. */
function citedWeb(body: string, web: Array<{ title: string; url: string }>): { body: string; sources: string[] } {
  const order: number[] = []
  const renumbered = body.replace(WEB_MARKER, (marker, n: string) => {
    const i = Number(n) - 1
    if (!web[i]) return marker
    if (!order.includes(i)) order.push(i)
    return `[${order.indexOf(i) + 1}]`
  })
  const sources = order.map((i, k) => `- **[${k + 1}]** [${web[i].title.replace(/[[\]]/g, '')}](${web[i].url})`)
  return { body: renumbered, sources }
}

const byLabel = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1))

function freeTitle(userId: string, base: string): string {
  const taken = (t: string) => !!sqlite.query('SELECT 1 FROM uploaded_files WHERE user_id = ? AND lower(filename) = lower(?)').get(userId, t)
  let title = base
  for (let n = 2; taken(title); n++) title = `${base.replace(/\)$/, '')} ${n})`
  return title
}

function markConfidential(id: string, confidential: boolean) {
  if (confidential) db.update(uploadedFiles).set({ confidential: true }).where(eq(uploadedFiles.id, id)).run()
}

/** Notes saved during a turn point at its chat and answer once those are stored — a new chat has
 *  no row until then — so the answer lists them. */
export function linkNotesToAnswer(userId: string, noteIds: string[], sessionId: string, messageId: string) {
  for (const id of noteIds) {
    sqlite.run('UPDATE uploaded_files SET origin_session_id = ?, origin_message_id = ? WHERE id = ? AND user_id = ?', [sessionId, messageId, id, userId])
  }
}

/** Puts an earlier version back, keeping the current one as a version in turn. Trust is left as it
 *  is: restoring is the user's own act. False when the version is not this note's. */
export async function restoreRevision(userId: string, noteId: string, revisionId: string): Promise<boolean> {
  const rev = noteRevisions(noteId).find(r => r.id === revisionId)
  const note = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, noteId)).get()
  if (!rev || !note || note.userId !== userId) return false
  recordRevision(noteId, note.filename, note.body ?? '', HUMAN_AUTHOR)
  await saveNote(userId, { id: noteId, title: rev.title, body: rev.body })
  return true
}
