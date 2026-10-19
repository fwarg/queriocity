import { sqlite } from '../db.ts'
import { noteTrust, type NoteStatus, type NoteTrust } from '../../../shared/note-trust.ts'

/** `edited`: the owner has changed the text of a note a model or an unknown author wrote. */
export interface NoteTrustRow { trust: NoteTrust; status: NoteStatus; edited: boolean }

/** Trust and lifecycle of the given notes; ids that are not notes are left out. */
export function trustByNote(ids: string[]): Map<string, NoteTrustRow> {
  if (!ids.length) return new Map()
  const rows = sqlite.query(`
    SELECT id, generated_by AS generatedBy, verified_at AS verifiedAt, edited_at AS editedAt, status
    FROM uploaded_files WHERE kind = 'note' AND id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as Array<{ id: string; generatedBy: string | null; verifiedAt: number | null; editedAt: number | null; status: NoteStatus | null }>
  return new Map(rows.map(r => [r.id, { trust: noteTrust(r.generatedBy, r.verifiedAt !== null), status: r.status ?? 'stable', edited: r.editedAt !== null }]))
}

/** Prompt lines naming the cited notes the user has not vouched for, so the model weighs them as
 *  less certain — those the user has edited, less so; empty when every note is the user's own or
 *  reviewed. */
export function trustInstruction(sources: Array<{ url: string; label?: string }>): string {
  const trust = trustByNote(sources.map(s => s.url.replace(/^file:/, '')))
  const weak = sources.flatMap(s => {
    const row = trust.get(s.url.replace(/^file:/, ''))
    return row && (row.trust === 'unreviewed' || row.trust === 'unknown') ? [{ label: `[${s.label}]`, edited: row.edited }] : []
  })
  const line = (notes: typeof weak, what: string, weigh: string) => {
    if (!notes.length) return ''
    const one = notes.length === 1
    return `${notes.map(n => n.label).join(', ')} ${one ? 'was' : 'were'} ${what}. Treat ${one ? 'its' : 'their'} claims as ${weigh}, and say so where an answer rests on them.`
  }
  return [
    line(weak.filter(n => !n.edited), 'written by a model or by an unknown author and not reviewed by the user', 'less certain than the user\'s own or reviewed notes'),
    line(weak.filter(n => n.edited), 'written by a model or by an unknown author and edited, but not reviewed, by the user', 'more certain than an untouched draft but less than a reviewed note'),
  ].filter(Boolean).join('\n')
}
