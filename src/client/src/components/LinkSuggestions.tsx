import { useEffect, useState } from 'react'
import { Check, Sparkles, X } from 'lucide-react'
import { acceptLinkSuggestion, dismissLinkSuggestion, fetchLinkSuggestions, type LinkSuggestion } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'

/** Links the small model proposes for one note, each accepted (written into the note) or dismissed
 *  (never proposed again). With `autoLoad` the list is fetched straight away — the review queue;
 *  otherwise a button asks for it, since each request costs a model call. */
export function LinkSuggestions({ noteId, autoLoad, onChanged, onOpen, onDone }: {
  noteId: string
  autoLoad?: boolean
  /** A link was written; the note changed. */
  onChanged: () => void
  onOpen?: (id: string) => void
  /** Every suggestion was handled, or there were none. */
  onDone?: () => void
}) {
  const t = useT()
  const [list, setList] = useState<LinkSuggestion[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try { setList(await fetchLinkSuggestions(noteId)) } catch (err) { setError(errorMessage(t, err, t('suggest.failed'))) }
    setLoading(false)
  }
  useEffect(() => { if (autoLoad) load() }, [noteId, autoLoad])
  useEffect(() => { if (list && list.length === 0) onDone?.() }, [list, onDone])

  async function settle(s: LinkSuggestion, accept: boolean) {
    setError('')
    try {
      if (accept) await acceptLinkSuggestion(noteId, s, t('links.seeAlso'))
      else await dismissLinkSuggestion(noteId, s.targetId)
      setList(prev => prev?.filter(x => x.targetId !== s.targetId) ?? null)
      if (accept) onChanged()
    } catch (err) { setError(errorMessage(t, err, t('related.failed'))) }
  }

  if (!list) {
    return (
      <div className="flex flex-col gap-1">
        <button onClick={load} disabled={loading} className="self-start flex items-center gap-1.5 px-2 py-1.5 rounded text-sm text-gray-300 border border-gray-700 hover:border-gray-500 disabled:opacity-50">
          <Sparkles size={13} className="text-amber-300" /> {t(loading ? 'suggest.loading' : 'suggest.button')}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {list.length === 0 && <p className="text-sm text-gray-500">{t('suggest.none')}</p>}
      {list.map(s => (
        <div key={s.targetId} className="flex items-start gap-2 rounded border border-gray-800 bg-gray-900/60 p-2">
          <div className="flex-1 min-w-0 text-sm">
            <button onClick={() => onOpen?.(s.targetId)} className="text-amber-300 hover:text-amber-200 text-left break-words">{s.title}</button>
            <p className="text-xs text-gray-500">
              {s.phrase ? t('suggest.inPlace', { phrase: s.phrase }) : t('suggest.seeAlso')}
              {s.reason && <> · {s.reason}</>}
            </p>
          </div>
          <button onClick={() => settle(s, true)} title={t('suggest.accept')} aria-label={t('suggest.accept')} className="p-2 rounded text-emerald-400 hover:bg-gray-800"><Check size={15} /></button>
          <button onClick={() => settle(s, false)} title={t('suggest.dismiss')} aria-label={t('suggest.dismiss')} className="p-2 rounded text-gray-500 hover:text-red-300 hover:bg-gray-800"><X size={15} /></button>
        </div>
      ))}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
