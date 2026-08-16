import { randomUUID } from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, uploadedFiles } from '../db.ts'
import { indexResourceText } from './ingest.ts'
import { describeResource } from './summarise.ts'

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
}

/** Creates or updates a note, re-indexing only when the text actually changed. */
export async function saveNote(userId: string, note: NoteInput): Promise<string> {
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
    // Only a resource this user owns, so a guessed id cannot reveal that someone else's exists.
    const source = note.derivedFrom
      ? await db.select({ id: uploadedFiles.id }).from(uploadedFiles)
          .where(and(eq(uploadedFiles.id, note.derivedFrom), eq(uploadedFiles.userId, userId))).get()
      : undefined
    await db.insert(uploadedFiles).values({
      id, userId, filename: title, mimeType: NOTE_MIME_TYPE, size,
      kind: 'note', body, derivedFrom: source?.id ?? null, createdAt: now, updatedAt: now,
    })
  }

  // Embedding is the expensive half, and a retitled note has the same content to retrieve.
  if (existing?.body !== body) {
    await indexResourceText(id, body, NOTE_MIME_TYPE, 0)
    await describeResource(id, body)
  }
  return id
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
