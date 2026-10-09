import { useCallback, useState } from 'react'
import type { Resource } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { LinkSuggestions } from './LinkSuggestions.tsx'

type Scope = 'unlinked' | 'all'

/** Goes through notes one at a time with their suggested links — for organising many notes at once,
 *  e.g. ones saved from a backlog of chats. The queue is fixed when started, so accepting a link
 *  (which makes a note "linked") does not reshuffle it; a note with nothing to suggest is skipped. */
export function LinkReview({ resources, onChanged, initialQueue }: {
  resources: Resource[]
  onChanged: () => void
  /** Start straight away with these notes — a topic's, from the topic map. */
  initialQueue?: Array<{ id: string; title: string }>
}) {
  const t = useT()
  const [scope, setScope] = useState<Scope>('unlinked')
  const summaryOf = (id: string) => resources.find(r => r.id === id)?.summary ?? null
  const [queue, setQueue] = useState<Array<{ id: string; title: string; summary: string | null }> | null>(
    () => initialQueue?.map(n => ({ ...n, summary: summaryOf(n.id) })) ?? null,
  )
  const [index, setIndex] = useState(0)

  const candidates = resources
    .filter(r => r.kind === 'note' && (scope === 'all' || r.linkCount === 0))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
  const start = () => { setQueue(candidates.map(r => ({ id: r.id, title: r.filename, summary: r.summary }))); setIndex(0) }
  const next = useCallback(() => setIndex(i => i + 1), [])

  if (!queue) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {(['unlinked', 'all'] as const).map(s => (
            <button key={s} onClick={() => setScope(s)} aria-pressed={scope === s}
              className={`px-3 py-1.5 rounded text-sm border ${scope === s ? 'bg-gray-700 text-gray-100 border-gray-500' : 'text-gray-400 border-gray-700 hover:text-gray-200'}`}>
              {t(s === 'unlinked' ? 'explore.unlinked' : 'review.allNotes')}
            </button>
          ))}
        </div>
        <button onClick={start} disabled={!candidates.length} className="self-start px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-sm text-white disabled:opacity-40">
          {t('review.start', { count: candidates.length })}
        </button>
      </div>
    )
  }

  const current = queue[index]
  if (!current) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-400">{t('review.finished', { count: queue.length })}</p>
        <button onClick={() => setQueue(null)} className="self-start text-sm text-gray-400 hover:text-gray-200 underline">{t('review.again')}</button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
        <span>{t('review.progress', { n: index + 1, total: queue.length })}</span>
        <span className="flex gap-3">
          <button onClick={next} className="py-1 hover:text-gray-200 underline">{t('review.skip')}</button>
          <button onClick={() => setQueue(null)} className="py-1 hover:text-gray-200 underline">{t('review.stop')}</button>
        </span>
      </div>
      {/* Not a link: opening the note would leave Explore and lose the queue. */}
      <div>
        <h3 className="text-base font-medium text-amber-300 break-words">{current.title}</h3>
        {current.summary && <p className="text-xs text-gray-500">{current.summary}</p>}
      </div>
      <LinkSuggestions key={current.id} noteId={current.id} autoLoad onChanged={onChanged} onDone={next} />
    </div>
  )
}
