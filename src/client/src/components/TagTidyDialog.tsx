import { useEffect, useState } from 'react'
import { proposeTagTidy, renameTag, type TagChange } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { Modal } from './Modal.tsx'

/** The small model's proposed renames for the tag tree, each ticked to apply. Applied in order, one
 *  rename at a time, stopping at the first that fails. */
export function TagTidyDialog({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const t = useT()
  const [changes, setChanges] = useState<TagChange[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    proposeTagTidy()
      .then(list => { setChanges(list); setPicked(new Set(list.map((_, i) => i))) })
      .catch(err => { setChanges([]); setError(errorMessage(t, err, t('tags.tidyFailed'))) })
  }, [t])

  const toggle = (i: number) => setPicked(p => { const next = new Set(p); if (!next.delete(i)) next.add(i); return next })

  async function apply() {
    if (!changes) return
    setBusy(true)
    setError('')
    for (const [i, c] of changes.entries()) {
      if (!picked.has(i)) continue
      try { await renameTag(c.from, c.to) } catch (err) {
        setError(errorMessage(t, err, t('tags.tidyApplyFailed', { tag: c.from })))
        setBusy(false)
        onApplied()
        return
      }
    }
    onApplied()
    onClose()
  }

  return (
    <Modal title={t('tags.tidyTitle')} onClose={onClose} maxWidth="max-w-lg">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-gray-500">{t('tags.tidyIntro')}</p>
        {!changes && <p className="text-sm text-gray-500">{t('tags.tidyLoading')}</p>}
        {changes?.length === 0 && !error && <p className="text-sm text-gray-400">{t('tags.tidyNone')}</p>}
        {changes && changes.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {changes.map((c, i) => (
              <li key={`${c.from}>${c.to}`}>
                <label className="flex items-start gap-2 text-sm text-gray-300">
                  <input type="checkbox" className="mt-1" checked={picked.has(i)} onChange={() => toggle(i)} disabled={busy} />
                  <span className="min-w-0">
                    <span className="text-emerald-300">#{c.from}</span> → <span className="text-emerald-300">#{c.to}</span>
                    <span className="text-xs text-gray-500"> · {t('tags.tidyCount', { count: c.count })}{c.merges && ` · ${t('tags.tidyMerges')}`}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm text-gray-300 hover:text-gray-100">{t('common.cancel')}</button>
          {changes && changes.length > 0 && (
            <button onClick={apply} disabled={busy || picked.size === 0} className="px-3 py-1.5 rounded text-sm bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white">
              {t('tags.tidyApply')} ({picked.size})
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
