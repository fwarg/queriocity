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
    await db.insert(uploadedFiles).values({
      id, userId, filename: title, mimeType: NOTE_MIME_TYPE, size,
      kind: 'note', body, createdAt: now, updatedAt: now,
    })
  }

  // Embedding is the expensive half, and a retitled note has the same content to retrieve.
  if (existing?.body !== body) {
    await indexResourceText(id, body, NOTE_MIME_TYPE, 0)
    await describeResource(id, body)
  }
  return id
}

/** Re-embeds notes that have no chunks, and reports how many it recovered.
 *
 *  Two ways a note ends up here: an `ALLOW_EMBED_RESET` run, which deletes every chunk but keeps
 *  note rows precisely so this can restore them, and a save whose embedding call failed after the
 *  row was already durable. Called at startup, where a note with no vectors is otherwise invisible
 *  to retrieval with nothing to signal it. */
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
