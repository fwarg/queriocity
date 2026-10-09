import { useEffect, useMemo, useState } from 'react'
import { fetchLibraryGraph, type GraphEdge, type LibraryGraphNode, type Space } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { EdgeLegend, GraphCanvas, NODE_FILL } from './GraphCanvas.tsx'
import { EmptyState } from './ui.tsx'

/** Colours for top-level tags, in order of size; the rest share the last. Readable on the dark
 *  background and distinct from each other at dot size. */
const GROUP_COLOURS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#2dd4bf', '#fb923c']
const OTHER_COLOUR = '#d1d5db'
/** Past this many nodes, labels wait until zoomed in. */
const LABEL_LIMIT = 60

type Graph = { nodes: LibraryGraphNode[]; edges: GraphEdge[]; total: number; truncated: boolean }

/** The whole library's explicit connections, coloured by top-level tag and narrowed by tag, space
 *  and whether chats join in. Isolated resources are left out; the tag tree lists them. */
export function GlobalGraph({ tags, spaces, tag, onTagChange, onOpenResource, onOpenChat }: {
  /** Every tag path, for the filter. */
  tags: string[]
  spaces: Space[]
  tag: string
  onTagChange: (tag: string) => void
  onOpenResource: (id: string) => void
  onOpenChat: (id: string, title: string) => void
}) {
  const t = useT()
  const [spaceId, setSpaceId] = useState('')
  const [chats, setChats] = useState(false)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    fetchLibraryGraph({ tag, spaceId, chats })
      .then(g => { if (live) { setGraph(g); setError(false) } })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [tag, spaceId, chats])

  const colourOf = useMemo(() => {
    const sizes = new Map<string, number>()
    for (const n of graph?.nodes ?? []) if (n.group) sizes.set(n.group, (sizes.get(n.group) ?? 0) + 1)
    const order = [...sizes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g)
    return new Map(order.map((g, i) => [g, GROUP_COLOURS[i] ?? OTHER_COLOUR]))
  }, [graph])

  const open = (n: LibraryGraphNode) => n.kind === 'chat' ? onOpenChat(n.id.slice('chat:'.length), n.label) : onOpenResource(n.id)
  const select = 'text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-indigo-500 max-w-full'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={tag} onChange={e => onTagChange(e.target.value)} aria-label={t('explore.filterTag')} className={select}>
          <option value="">{t('explore.allTags')}</option>
          {tags.map(p => <option key={p} value={p}>#{p}</option>)}
        </select>
        <select value={spaceId} onChange={e => setSpaceId(e.target.value)} aria-label={t('explore.filterSpace')} className={select}>
          <option value="">{t('explore.allSpaces')}</option>
          {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-400">
          <input type="checkbox" checked={chats} onChange={e => setChats(e.target.checked)} />
          {t('explore.includeChats')}
        </label>
      </div>
      {error ? <p className="text-sm text-red-400">{t('explore.graphFailed')}</p>
        : !graph ? null
        : graph.nodes.length === 0 ? <EmptyState>{t('explore.graphEmpty')}</EmptyState>
        : (
          <>
            {graph.truncated && <p className="text-xs text-amber-400">{t('explore.truncated', { shown: graph.nodes.length, total: graph.total })}</p>}
            <GraphCanvas
              nodes={graph.nodes}
              edges={graph.edges}
              width={800}
              height={560}
              zoomable
              showLabels={graph.nodes.length <= LABEL_LIMIT}
              fillOf={n => n.group ? colourOf.get(n.group) ?? OTHER_COLOUR : NODE_FILL[n.kind]}
              onOpen={open}
            />
            <div className="flex flex-wrap gap-3 text-[11px] text-gray-400">
              {[...colourOf].map(([g, c]) => (
                <span key={g} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: c }} />#{g}</span>
              ))}
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: NODE_FILL.note }} />{t('explore.untaggedNote')}</span>
              {chats && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: NODE_FILL.chat }} />{t('explore.chat')}</span>}
            </div>
            <EdgeLegend />
          </>
        )}
    </div>
  )
}
