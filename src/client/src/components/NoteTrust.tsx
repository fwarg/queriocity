import { useState } from 'react'
import { BadgeCheck } from 'lucide-react'
import { updateNote, type Resource } from '../lib/api.ts'
import { useLang, useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { NOTE_STATUSES, UNKNOWN_MODEL, noteTrust, type NoteStatus } from '@shared/note-trust.ts'
import type { TranslationKey } from '@shared/i18n/index.ts'

type TrustFields = Pick<Resource, 'kind' | 'generatedBy' | 'verifiedAt' | 'editedAt' | 'status'>

/** A list-row marker for notes the user has not vouched for, or that are not current; nothing for
 *  the user's own and reviewed notes, which is most of them. */
export function NoteTrustBadge({ resource }: { resource: TrustFields }) {
  const t = useT()
  if (resource.kind !== 'note') return null
  const trust = noteTrust(resource.generatedBy, resource.verifiedAt !== null)
  const marks: TranslationKey[] = []
  if (trust === 'unreviewed' || trust === 'unknown') marks.push(`trust.badge.${trust}`)
  if (resource.editedAt !== null && trust !== 'yours') marks.push('trust.badge.edited')
  if (resource.status === 'draft' || resource.status === 'deprecated') marks.push(`trust.badge.${resource.status}`)
  if (!marks.length) return null
  return <span className="text-xs text-amber-400/80"> · {marks.map(k => t(k)).join(' · ')}</span>
}

/** Who wrote the note and whether it is reviewed, with the actions that change either, and its status. */
export function NoteTrustSection({ note, onChanged }: { note: TrustFields & { id: string }; onChanged: () => void }) {
  const t = useT()
  const { lang } = useLang()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const trust = noteTrust(note.generatedBy, note.verifiedAt !== null)
  const day = (epochSeconds: number | null) => epochSeconds ? new Date(epochSeconds * 1000).toLocaleDateString(lang) : ''
  const date = day(note.verifiedAt)

  async function change(patch: Parameters<typeof updateNote>[1]) {
    setBusy(true)
    setError('')
    try {
      await updateNote(note.id, patch)
      onChanged()
    } catch (e) {
      setError(errorMessage(t, e, t('trust.failed')))
    } finally {
      setBusy(false)
    }
  }

  const model = note.generatedBy === UNKNOWN_MODEL ? t('trust.someModel') : note.generatedBy ?? ''
  const description = trust === 'yours' ? t('trust.yours')
    : trust === 'reviewed' ? t(note.generatedBy ? 'trust.reviewed' : 'trust.reviewedUnknown', { model, date })
    : trust === 'unreviewed' ? t('trust.unreviewed', { model })
    : t('trust.unknown')
  // A model's note the owner has changed: still not reviewed until marked, but no longer only the model's.
  const edited = note.editedAt !== null && trust !== 'yours' ? t('trust.edited', { date: day(note.editedAt) }) : ''
  const button = 'px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50'

  return (
    <div className="flex flex-col gap-1.5">
      <p className={`text-sm flex items-center gap-1.5 ${trust === 'unreviewed' || trust === 'unknown' ? 'text-amber-300' : 'text-gray-300'}`}>
        {trust === 'reviewed' && <BadgeCheck size={14} className="shrink-0 text-emerald-400" />}
        {description}{edited}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {trust === 'unknown' && <>
          <button disabled={busy} onClick={() => change({ author: 'human' })} className={button}>{t('trust.claim')}</button>
          <button disabled={busy} onClick={() => change({ author: 'model' })} className={button}>{t('trust.claimModel')}</button>
        </>}
        {trust !== 'yours' && (
          <button disabled={busy} onClick={() => change({ reviewed: trust !== 'reviewed' })} className={button}>
            {t(trust === 'reviewed' ? 'trust.unmarkReviewed' : 'trust.markReviewed')}
          </button>
        )}
        <label className="flex items-center gap-1.5 text-xs text-gray-400">
          {t('trust.status')}
          <select
            value={note.status ?? 'stable'}
            disabled={busy}
            onChange={e => change({ status: e.target.value as NoteStatus })}
            className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200"
          >
            {NOTE_STATUSES.map(s => <option key={s} value={s}>{t(`trust.status.${s}`)}</option>)}
          </select>
        </label>
      </div>
      {(trust === 'unreviewed' || trust === 'unknown') && <p className="text-xs text-gray-500">{t('trust.hint')}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
