/** Who wrote a note and whether its owner has checked it, after OKF's `generated` / `verified`.
 *
 *  Notes only: a file's text is extracted, not written, so there is nothing to review in it. */

/** `generated_by` for a note the user wrote. Any other non-null value is the writing model's label. */
export const HUMAN_AUTHOR = 'human'

/** `generated_by` for a note the user marked as a model's without knowing which model. */
export const UNKNOWN_MODEL = 'model'

export const NOTE_STATUSES = ['draft', 'stable', 'deprecated'] as const
export type NoteStatus = typeof NOTE_STATUSES[number]

/** yours: the user wrote it. reviewed: a model wrote it and the user checked it. unreviewed: a model
 *  wrote it, unchecked. unknown: saved before authorship was recorded, unchecked. */
export type NoteTrust = 'yours' | 'reviewed' | 'unreviewed' | 'unknown'

export function noteTrust(generatedBy: string | null | undefined, verified: boolean): NoteTrust {
  if (generatedBy === HUMAN_AUTHOR) return 'yours'
  if (verified) return 'reviewed'
  return generatedBy ? 'unreviewed' : 'unknown'
}
