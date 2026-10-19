import { randomUUID } from 'crypto'
import { sqlite } from '../db.ts'

/** Earlier versions of a note, kept when an agent reworks its draft, when the user edits a note a
 *  model wrote, and when an earlier version is restored — so each can be undone. */

const REVISIONS_KEPT = 10

/** Keeps a version of a note before it is replaced; `actor` is a model label or `human`. */
export function recordRevision(noteId: string, title: string, body: string, actor: string) {
  sqlite.run('INSERT INTO note_revisions (id, note_id, title, body, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [randomUUID(), noteId, title, body, actor, Math.floor(Date.now() / 1000)])
  sqlite.run(`DELETE FROM note_revisions WHERE note_id = ? AND id NOT IN (
    SELECT id FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`, [noteId, noteId, REVISIONS_KEPT])
}

export interface Revision { id: string; title: string; body: string; actor: string; createdAt: number }

/** A note's earlier versions, newest first. The caller checks ownership of the note. */
export function noteRevisions(noteId: string): Revision[] {
  return sqlite.query(`SELECT id, title, body, actor, created_at AS createdAt FROM note_revisions
    WHERE note_id = ? ORDER BY created_at DESC, rowid DESC`).all(noteId) as Revision[]
}
