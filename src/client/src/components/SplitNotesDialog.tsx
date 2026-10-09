import { useEffect, useState } from 'react'
import { ArrowDownToLine, Eye, Pencil } from 'lucide-react'
import { addSeeAlso, createNote, proposeNoteSplit, type NoteOptions } from '../lib/api.ts'
import { wikilinkFor } from '@shared/wikilinks.ts'
import { mergeParts } from '@shared/note-split.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { Modal } from './Modal.tsx'
import { NoteMarkdown } from './NoteMarkdown.tsx'

interface Part { title: string; body: string; keep: boolean; editing: boolean }

/** Proposes a long answer or note as several short notes, one idea each, for the user to shape and
 *  save: drop, retitle, edit or merge parts, or ask again with a hint. From an answer, an optional
 *  overview note links the parts; from a note, the parts are "made from" it and can be linked from
 *  it under See also. */
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
  const [hint, setHint] = useState('')
  const [overview, setOverview] = useState(true)
  // The overview's own title and summary, proposed from the text being split rather than taken
  // from the chat it came from; editable like the parts.
  const [overviewTitle, setOverviewTitle] = useState(title)
  const [overviewSummary, setOverviewSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function propose(withHint = '') {
    setBusy(true)
    setError('')
    setParts(null)
    try {
      const proposal = await proposeNoteSplit(title, body, withHint)
      setParts(proposal.parts.map(p => ({ ...p, keep: true, editing: false })))
      setOverviewTitle(proposal.overview?.title ?? title)
      setOverviewSummary(proposal.overview?.body ?? '')
    } catch (err) { setError(errorMessage(t, err, t('split.failed'))) }
    setBusy(false)
  }
  // Once, on open; `propose` is not a dependency or every render would re-request the split.
  useEffect(() => { propose() }, [title, body])

  const update = (i: number, patch: Partial<Part>) => setParts(ps => ps?.map((p, j) => j === i ? { ...p, ...patch } : p) ?? null)
  const mergeWithNext = (i: number) => setParts(ps => {
    if (!ps || !ps[i + 1]) return ps
    const merged = { ...ps[i], ...mergeParts(ps[i], ps[i + 1]), keep: true }
    return [...ps.slice(0, i), merged, ...ps.slice(i + 2)]
  })
  const kept = parts?.filter(p => p.keep && p.title.trim() && p.body.trim()) ?? []

  async function save() {
    setBusy(true)
    setError('')
    try {
      const saved: Array<{ id: string; title: string }> = []
      for (const p of kept) saved.push({ id: (await createNote(p.title.trim(), p.body, options)).id, title: p.title.trim() })
      if (overview && fromNoteId) {
        for (const s of saved) await addSeeAlso(fromNoteId, s.id, t('links.seeAlso'))
      } else if (overview) {
        const links = `${t('split.overviewIntro')}\n\n${saved.map(s => `- ${wikilinkFor(s.title)}`).join('\n')}`
        const hub = overviewSummary.trim() ? `${overviewSummary.trim()}\n\n${links}` : links
        const hubTitle = overviewTitle.trim() || title.trim() || t('split.overviewTitle')
        saved.push({ id: (await createNote(hubTitle, hub, options)).id, title: hubTitle })
      }
      onSaved(saved)
    } catch (err) {
      setError(errorMessage(t, err, t('split.failed')))
      setBusy(false)
    }
  }

  const field = 'text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-100 focus:outline-none focus:border-blue-500'
  return (
    <Modal title={t('split.title')} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        {busy && !parts && <p className="text-sm text-gray-400">{t('split.working')}</p>}
        {parts?.map((p, i) => (
          <div key={i} className={`flex flex-col gap-1.5 rounded border p-2 ${p.keep ? 'border-gray-700' : 'border-gray-800 opacity-50'}`}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={p.keep} onChange={e => update(i, { keep: e.target.checked })} aria-label={t('split.keep')} />
              <input value={p.title} onChange={e => update(i, { title: e.target.value })} aria-label={t('split.partTitle')} className={`flex-1 min-w-0 ${field}`} />
              <button onClick={() => update(i, { editing: !p.editing })} title={t(p.editing ? 'split.preview' : 'split.edit')} aria-label={t(p.editing ? 'split.preview' : 'split.edit')} className="p-1.5 rounded text-gray-400 hover:text-gray-200">
                {p.editing ? <Eye size={14} /> : <Pencil size={14} />}
              </button>
            </div>
            {p.editing
              ? <textarea value={p.body} onChange={e => update(i, { body: e.target.value })} rows={8} aria-label={t('split.partBody')} className={`font-mono ${field}`} />
              : <div className="max-h-40 overflow-y-auto rounded bg-gray-900 px-2 py-1"><NoteMarkdown body={p.body} /></div>}
            {i < parts.length - 1 && (
              <button onClick={() => mergeWithNext(i)} className="self-start flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
                <ArrowDownToLine size={12} /> {t('split.mergeNext')}
              </button>
            )}
          </div>
        ))}
        {(parts || error) && (
          <div className="flex flex-wrap items-center gap-2">
            <input value={hint} onChange={e => setHint(e.target.value)} placeholder={t('split.hintPlaceholder')} aria-label={t('split.hintPlaceholder')}
              onKeyDown={e => { if (e.key === 'Enter' && !busy) propose(hint) }} className={`flex-1 min-w-[12rem] ${field}`} />
            <button onClick={() => propose(hint)} disabled={busy} className="px-3 py-1.5 rounded text-sm text-gray-200 border border-gray-700 hover:border-gray-500 disabled:opacity-40">
              {t('split.again')}
            </button>
          </div>
        )}
        {parts && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={overview} onChange={e => setOverview(e.target.checked)} />
            {t(fromNoteId ? 'split.linkFromOriginal' : 'split.overview')}
          </label>
        )}
        {parts && overview && !fromNoteId && (
          <div className="flex flex-col gap-1.5 rounded border border-gray-700 p-2">
            <input value={overviewTitle} onChange={e => setOverviewTitle(e.target.value)} aria-label={t('split.overviewTitleLabel')} placeholder={t('split.overviewTitleLabel')} className={field} />
            <textarea value={overviewSummary} onChange={e => setOverviewSummary(e.target.value)} rows={3} aria-label={t('split.overviewSummaryLabel')} placeholder={t('split.overviewSummaryLabel')} className={field} />
          </div>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm text-gray-400 hover:text-gray-200">{t('common.cancel')}</button>
          <button onClick={save} disabled={busy || !kept.length} className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-sm text-white disabled:opacity-40">
            {t('split.save', { count: kept.length })}
          </button>
        </div>
      </div>
    </Modal>
  )
}
