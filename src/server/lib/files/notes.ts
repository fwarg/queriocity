import { randomUUID } from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { chatSessions, db, uploadedFiles } from '../db.ts'
import { indexResourceText } from './ingest.ts'
import { bodiesRelinkedTo, resolveDangling, syncLinks } from './links.ts'
import { describeResource } from './summarise.ts'
import { setResourceTags } from './tags.ts'
import { plainCitations } from '../../../shared/note-citations.ts'

/** Notes: the one resource the user writes rather than uploads.
 *
 *  A note is an `uploaded_files` row with `kind = 'note'`, so it inherits space tagging, tagged-file
 *  RAG, `uploads_search`, the per-resource context checkboxes and delete-cascade with no code of its
 *  own. Its title is the `filename` column — the label every citation and retrieval path already
 *  reads — and its markdown lives in `body`, which is also what makes it re-embeddable after an
 *  embedding-dimension reset. `contentHash` stays null: two notes may legitimately share a body, and
 *  the hash would go stale on the next edit anyway. */

export const NOTE_MIME_TYPE = 'text/markdown'

export interface NoteInput {
  id?: string
  title: string
  body: string
  /** The resource a transform produced this note from; set once, at creation. */
  derivedFrom?: string
  /** The chat and answer this note was saved from; set once, at creation. */
  originSessionId?: string
  originMessageId?: string
  /** Replaces the note's tags when given; left alone when omitted. */
  tags?: string[]
}

/** Creates or updates a note, re-indexing only when the text actually changed.
 *  `describe: false` skips the small-model summary — for mechanical edits such as a link rewrite. */
export async function saveNote(userId: string, note: NoteInput, { describe = true } = {}): Promise<string> {
  const title = note.title.trim()
  const body = note.body.trim()
  if (!title) throw new Error('A note needs a title')
  if (!body) throw new Error('A note needs some content')

  const existing = note.id
    ? await db.select().from(uploadedFiles)
        .where(and(eq(uploadedFiles.id, note.id), eq(uploadedFiles.userId, userId))).get()
    : undefined
  if (note.id && (!existing || existing.kind !== 'note')) throw new Error('Note not found')

  const id = existing?.id ?? randomUUID()
  const size = Buffer.byteLength(body, 'utf8')
  const now = new Date()

  if (existing) {
    await db.update(uploadedFiles)
      .set({ filename: title, body, size, updatedAt: now })
      .where(eq(uploadedFiles.id, id))
  } else {
    await db.insert(uploadedFiles).values({
      id, userId, filename: title, mimeType: NOTE_MIME_TYPE, size, kind: 'note', body,
      ...await ownedProvenance(userId, note), createdAt: now, updatedAt: now,
    })
  }
  if (note.tags) setResourceTags(userId, id, note.tags)

  // Embedding is the expensive half, and a retitled note has the same content to retrieve.
  if (existing?.body !== body) {
    syncLinks(userId, id, body)
    await indexResourceText(id, body, NOTE_MIME_TYPE, 0)
    if (describe) await describeResource(id, body)
  }
  if (!existing) resolveDangling(userId, id, title)
  else if (existing.filename !== title) await relinkRenamed(userId, id, existing.filename, title)
  return id
}

/** derivedFrom and the chat of origin, each kept only when this user owns it — so a guessed id
 *  cannot reveal that someone else's resource or chat exists. */
async function ownedProvenance(userId: string, note: NoteInput) {
  const source = note.derivedFrom
    ? await db.select({ id: uploadedFiles.id }).from(uploadedFiles)
        .where(and(eq(uploadedFiles.id, note.derivedFrom), eq(uploadedFiles.userId, userId))).get()
    : undefined
  const session = note.originSessionId
    ? await db.select({ id: chatSessions.id }).from(chatSessions)
        .where(and(eq(chatSessions.id, note.originSessionId), eq(chatSessions.userId, userId))).get()
    : undefined
  return {
    derivedFrom: source?.id ?? null,
    originSessionId: session?.id ?? null,
    originMessageId: session ? note.originMessageId ?? null : null,
  }
}

/** Renames any resource, keeping `[[links]]` to it pointing at it under the new title. */
export async function renameResource(userId: string, id: string, oldTitle: string, newTitle: string): Promise<void> {
  await db.update(uploadedFiles)
    .set({ filename: newTitle, updatedAt: new Date() })
    .where(and(eq(uploadedFiles.id, id), eq(uploadedFiles.userId, userId)))
  await relinkRenamed(userId, id, oldTitle, newTitle)
}

/** Rewrite `[[oldTitle]]` in the notes linking to a renamed resource, and adopt dangling links that
 *  already used the new title. Rewritten notes are re-indexed (their text changed) but not re-described. */
async function relinkRenamed(userId: string, id: string, oldTitle: string, newTitle: string): Promise<void> {
  for (const linking of bodiesRelinkedTo(userId, id, oldTitle, newTitle)) {
    await saveNote(userId, linking, { describe: false })
  }
  resolveDangling(userId, id, newTitle)
}

/** Rewrites notes saved from answers in the older form, where every citation marker carried its own
 *  URL (`[\[1\]](https://…)`), to plain `[1]` markers paired with the note's sources list. Only markers
 *  whose URL that list already holds are touched, so no source is lost. Idempotent — a converted
 *  note no longer matches — and run at startup, so it needs no flag. Re-indexed (the text changed),
 *  not re-described (the meaning did not). Returns how many notes changed. */
export async function simplifyNoteCitations(): Promise<number> {
  const candidates = await db.select({ id: uploadedFiles.id, userId: uploadedFiles.userId, title: uploadedFiles.filename, body: uploadedFiles.body })
    .from(uploadedFiles)
    // A bound parameter: a backslash written inside the sql tag does not reach SQLite as written.
    .where(and(eq(uploadedFiles.kind, 'note'), sql`${uploadedFiles.body} LIKE ${'%[\\[%'}`))
  let changed = 0
  for (const note of candidates) {
    const body = plainCitations(note.body ?? '')
    if (body === note.body) continue
    try {
      await saveNote(note.userId, { id: note.id, title: note.title, body }, { describe: false })
      changed++
    } catch (e) {
      console.warn(`  [notes] could not simplify citations in ${note.id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  if (changed) console.log(`  [notes] simplified citation links in ${changed} note(s)`)
  return changed
}

/** Re-chunks notes that have no chunks at all, and reports how many it recovered.
 *
 *  Narrower than reembedMissingVectors, which restores a vector from chunk text still on disk: this
 *  is for a note whose chunk *text* was never written, because `indexResourceText` embedded before
 *  it stored and the embedding call failed. Only a note can be recovered from that — its markdown is
 *  in `body`, whereas an uploaded file's text exists nowhere but the chunks. Called at startup,
 *  where a note missing from retrieval has nothing else to signal it. */
export async function reindexNotes(): Promise<number> {
  const orphaned = await db.select({ id: uploadedFiles.id, body: uploadedFiles.body })
    .from(uploadedFiles)
    .where(and(
      eq(uploadedFiles.kind, 'note'),
      sql`${uploadedFiles.id} NOT IN (SELECT file_id FROM file_chunk_meta)`,
    ))
  const pending = orphaned.filter(n => n.body?.trim())
  if (!pending.length) return 0

  console.log(`  [notes] re-embedding ${pending.length} note(s) with no chunks`)
  let done = 0
  for (const note of pending) {
    try {
      await indexResourceText(note.id, note.body!, NOTE_MIME_TYPE, 0)
      done++
    } catch (e) {
      console.warn(`  [notes] could not re-embed ${note.id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  return done
}
