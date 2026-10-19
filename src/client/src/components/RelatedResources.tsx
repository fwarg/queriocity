import { useEffect, useState } from 'react'
import { ResourceTypeIcon } from './ResourceFilters.tsx'
import { addSeeAlso, fetchRelated, type RelatedResource, type ResourceDetail, type TagSuggestion } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'

type Related = Awaited<ReturnType<typeof fetchRelated>>

/** Resources similar to this one and the tags several of them share; null while loading. Fetched
 *  again when the resource changes or gains a link. */
export function useRelated(detail: ResourceDetail | null): Related | null {
  const id = detail?.id
  const key = detail && `${detail.id}:${detail.updatedAt}:${detail.backlinks.length}`
  const [loaded, setLoaded] = useState<{ key: string; data: Related } | null>(null)
  useEffect(() => {
    if (!id || !key) return
    fetchRelated(id).then(data => setLoaded({ key, data })).catch(() => setLoaded({ key, data: { related: [], tags: [] } }))
  }, [id, key])
  return loaded && loaded.key === key ? loaded.data : null
}

/** The topics' suggestions with the tags similar resources share: the user's own tags first. */
export function withSharedTags(suggestions: TagSuggestion[], shared: Related['tags'] = []): TagSuggestion[] {
  const all = [...suggestions.filter(s => s.existing), ...shared.map(({ path }) => ({ path, existing: true })), ...suggestions.filter(s => !s.existing)]
  return all.filter((s, i) => all.findIndex(o => o.path === s.path) === i)
}

/** Resources close in content to this one — connections not yet made. Each can be linked with one
 *  tap (a "See also" line in the note); the tags they share are offered in the tag editor. Nothing
 *  changes until the user taps. */
export function RelatedResources({ detail, related, onOpen, onChanged }: {
  detail: ResourceDetail
  related: RelatedResource[]
  onOpen: (id: string) => void
  onChanged: () => void
}) {
  const t = useT()
  const [error, setError] = useState('')

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

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">{t('related.title')}</h3>
      <p className="text-xs text-gray-500">{t('related.intro')}</p>
      {related.length === 0 && <p className="text-sm text-gray-500">{t('related.none')}</p>}
      <div className="flex flex-col gap-1">
        {related.map(r => {
          const link = linkAction(r)
          return (
            <div key={r.id} className="flex items-center gap-2 min-w-0">
              <button
                onClick={() => onOpen(r.id)}
                className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1.5 rounded text-sm text-left text-gray-300 bg-gray-800 border border-gray-700 hover:border-gray-500 hover:text-gray-100"
              >
                <ResourceTypeIcon resource={r} size={13} />
                <span className="truncate">{r.filename}</span>
              </button>
              {link
                ? <button onClick={link.run} className="shrink-0 px-2.5 py-1.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-200">{link.label}</button>
                : r.linked && <span className="shrink-0 px-2 text-xs text-gray-500">{t('related.linked')}</span>}
            </div>
          )
        })}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
