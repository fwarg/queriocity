import { useEffect, useState } from 'react'
import { addSeeAlso, createNote, proposeNoteSplit, type NoteOptions } from '../lib/api.ts'
import { wikilinkFor } from '@shared/wikilinks.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { Modal } from './Modal.tsx'
import { NoteMarkdown } from './NoteMarkdown.tsx'

interface Part { title: string; body: string; keep: boolean }

/** Proposes a long answer or note as several short notes, one idea each, for the user to trim and
 *  save. From an answer, an optional overview note links the parts; from a note, the parts are
 *  "made from" it and can be linked from it under See also. */
export function SplitNotesDialog({ title, body, options, fromNoteId, onClose, onSaved }: {
  title: string
  body: string
  /** Provenance every part gets: the chat and answer, or the note it was made from. */
  options: NoteOptions
  /** Splitting an existing note rather than an answer. */
  fromNoteId?: string
  onClose: () => void
  onSaved: (notes: Array<{ id: string; title: string }>) => void
}) {
  const t = useT()
  const [parts, setParts] = useState<Part[] | null>(null)
  const [overview, setOverview] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    proposeNoteSplit(title, body)
      .then(ps => setParts(ps.map(p => ({ ...p, keep: true }))))
      .catch(err => setError(errorMessage(t, err, t('split.failed'))))
  // Not on `t`: a new function each render would re-request the split.
  }, [title, body])

  const update = (i: number, patch: Partial<Part>) => setParts(ps => ps?.map((p, j) => j === i ? { ...p, ...patch } : p) ?? null)
  const kept = parts?.filter(p => p.keep && p.title.trim()) ?? []

  async function save() {
    setSaving(true)
    setError('')
    try {
      const saved: Array<{ id: string; title: string }> = []
      for (const p of kept) saved.push({ id: (await createNote(p.title.trim(), p.body, options)).id, title: p.title.trim() })
      if (overview && fromNoteId) {
        for (const s of saved) await addSeeAlso(fromNoteId, s.id, t('links.seeAlso'))
      } else if (overview) {
        const hub = `${t('split.overviewIntro')}\n\n${saved.map(s => `- ${wikilinkFor(s.title)}`).join('\n')}`
        saved.push({ id: (await createNote(title.trim() || t('split.overviewTitle'), hub, options)).id, title })
      }
      onSaved(saved)
    } catch (err) {
      setError(errorMessage(t, err, t('split.failed')))
      setSaving(false)
    }
  }

  return (
    <Modal title={t('split.title')} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        {!parts && !error && <p className="text-sm text-gray-400">{t('split.working')}</p>}
        {parts?.map((p, i) => (
          <div key={i} className={`flex flex-col gap-1.5 rounded border p-2 ${p.keep ? 'border-gray-700' : 'border-gray-800 opacity-50'}`}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={p.keep} onChange={e => update(i, { keep: e.target.checked })} aria-label={t('split.keep')} />
              <input value={p.title} onChange={e => update(i, { title: e.target.value })} aria-label={t('split.partTitle')}
                className="flex-1 min-w-0 text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-100 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="max-h-40 overflow-y-auto rounded bg-gray-900 px-2 py-1"><NoteMarkdown body={p.body} /></div>
          </div>
        ))}
        {parts && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={overview} onChange={e => setOverview(e.target.checked)} />
            {t(fromNoteId ? 'split.linkFromOriginal' : 'split.overview')}
          </label>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm text-gray-400 hover:text-gray-200">{t('common.cancel')}</button>
          <button onClick={save} disabled={saving || !kept.length} className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-sm text-white disabled:opacity-40">
            {t('split.save', { count: kept.length })}
          </button>
        </div>
      </div>
    </Modal>
  )
}
