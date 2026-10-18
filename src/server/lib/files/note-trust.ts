import { sqlite } from '../db.ts'
import { noteTrust, type NoteStatus, type NoteTrust } from '../../../shared/note-trust.ts'

export interface NoteTrustRow { trust: NoteTrust; status: NoteStatus }

/** Trust and lifecycle of the given notes; ids that are not notes are left out. */
export function trustByNote(ids: string[]): Map<string, NoteTrustRow> {
  if (!ids.length) return new Map()
  const rows = sqlite.query(`
    SELECT id, generated_by AS generatedBy, verified_at AS verifiedAt, status
    FROM uploaded_files WHERE kind = 'note' AND id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as Array<{ id: string; generatedBy: string | null; verifiedAt: number | null; status: NoteStatus | null }>
  return new Map(rows.map(r => [r.id, { trust: noteTrust(r.generatedBy, r.verifiedAt !== null), status: r.status ?? 'stable' }]))
}

/** A prompt line naming the cited notes the user has not vouched for, so the model weighs them as
 *  less certain; empty when every note is the user's own or reviewed. */
export function trustInstruction(sources: Array<{ url: string; label?: string }>): string {
  const trust = trustByNote(sources.map(s => s.url.replace(/^file:/, '')))
  const weak = sources.filter(s => {
    const t = trust.get(s.url.replace(/^file:/, ''))?.trust
    return t === 'unreviewed' || t === 'unknown'
  })
  if (!weak.length) return ''
  const labels = weak.map(s => `[${s.label}]`).join(', ')
  return `${labels} ${weak.length === 1 ? 'was' : 'were'} written by a model or by an unknown author and not reviewed by the user. Treat ${weak.length === 1 ? 'its' : 'their'} claims as less certain than the user's own or reviewed notes, and say so where an answer rests on them.`
}
