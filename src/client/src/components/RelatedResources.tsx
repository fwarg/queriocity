import { useEffect, useState } from 'react'
import { FileText, NotebookPen, Plus } from 'lucide-react'
import { addSeeAlso, fetchRelated, setResourceTags, type RelatedResource, type ResourceDetail } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'

/** Resources close in content to this one — connections not yet made. Each can be linked with one
 *  tap (a "See also" line in the note), and tags several of them share can be adopted. Nothing
 *  changes until the user taps. */
export function RelatedResources({ detail, onOpen, onChanged }: {
  detail: ResourceDetail
  onOpen: (id: string) => void
  onChanged: () => void
}) {
  const t = useT()
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchRelated>> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { fetchRelated(detail.id).then(setData).catch(() => setData({ related: [], tags: [] })) }, [detail.id])

  async function act(action: Promise<unknown>) {
    setError('')
    try { await action; onChanged() } catch (err: unknown) { setError(errorMessage(t, err, t('related.failed'))) }
  }

  /** A note links out itself; from a file, the link goes into the related note instead. */
  function linkAction(r: RelatedResource): { label: string; run: () => void } | null {
    if (r.linked) return null
    if (detail.kind === 'note') return { label: t('related.link'), run: () => act(addSeeAlso(detail.id, r.id, t('links.seeAlso'))) }
    if (r.kind === 'note') return { label: t('related.linkFrom'), run: () => act(addSeeAlso(r.id, detail.id, t('links.seeAlso'))) }
    return null
  }

  if (!data) return null
  // Adopted hints drop out at once; the list itself is refetched only when the resource changes.
  const tagHints = data.tags.filter(({ path }) => !detail.tags.includes(path))
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">{t('related.title')}</h3>
      <p className="text-xs text-gray-500">{t('related.intro')}</p>
      {data.related.length === 0 && <p className="text-sm text-gray-500">{t('related.none')}</p>}
      <div className="flex flex-col gap-1">
        {data.related.map(r => {
          const link = linkAction(r)
          return (
            <div key={r.id} className="flex items-center gap-2 min-w-0">
              <button
                onClick={() => onOpen(r.id)}
                className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1.5 rounded text-sm text-left text-gray-300 bg-gray-800 border border-gray-700 hover:border-gray-500 hover:text-gray-100"
              >
                {r.kind === 'note'
                  ? <NotebookPen size={13} className="shrink-0 text-amber-400" />
                  : <FileText size={13} className="shrink-0 text-gray-500" />}
                <span className="truncate">{r.filename}</span>
              </button>
              {link
                ? <button onClick={link.run} className="shrink-0 px-2.5 py-1.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-200">{link.label}</button>
                : r.linked && <span className="shrink-0 px-2 text-xs text-gray-500">{t('related.linked')}</span>}
            </div>
          )
        })}
      </div>
      {tagHints.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          <span className="text-xs text-gray-500">{t('related.tagHint')}:</span>
          {tagHints.map(({ path, count }) => (
            <button
              key={path}
              onClick={() => act(setResourceTags(detail.id, [...detail.tags, path]))}
              className="flex items-center gap-1 px-2 py-1 rounded-full text-xs text-gray-300 border border-dashed border-gray-600 hover:text-emerald-300 hover:border-emerald-700"
            >
              <Plus size={11} />#{path} <span className="text-gray-500">{count}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
