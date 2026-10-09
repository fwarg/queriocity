import { useEffect, useMemo, useState } from 'react'
import { useElementSize } from '../lib/use-element-size.ts'
import { fetchLibraryGraph, type GraphEdge, type LibraryGraphNode, type Space, type Topic } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { EdgeLegend, GraphCanvas, NODE_FILL } from './GraphCanvas.tsx'
import { EmptyState } from './ui.tsx'
import { DIMMED, GROUP_COLOURS, OTHER_COLOUR, groupColour } from '../lib/topic-colours.ts'

/** Colours for top-level tags, in order of size; the rest share the last. Readable on the dark
 *  background and distinct from each other at dot size. */
/** Labels show from the start when each node has at least this much room (px²); otherwise once
 *  zoomed in. A wide monitor thus labels a graph a phone would not. */
const LABEL_AREA_PER_NODE = 12_000
const MIN_HEIGHT = 400
/** Room kept below the drawing for the legends, so the page doesn't scroll. */
const BELOW = 80

type Graph = { nodes: LibraryGraphNode[]; edges: GraphEdge[]; total: number; truncated: boolean }

/** The whole library's explicit connections, coloured by top-level tag and narrowed by tag, space
 *  and whether chats join in. Isolated resources are left out; the tag tree lists them. */
export function GlobalGraph({ tags, spaces, tag, onTagChange, onOpenResource, onOpenChat, topics, focusTopic, onFocusTopicChange }: {
  /** Every tag path, for the filter. */
  tags: string[]
  spaces: Space[]
  tag: string
  onTagChange: (tag: string) => void
  onOpenResource: (id: string) => void
  onOpenChat: (id: string, title: string) => void
  /** The topic map, once built; colouring by topic asks for it. */
  topics?: Topic[]
  /** null: colour by tag. '': colour by topic. A topic key: that topic highlighted, the rest dimmed. */
  focusTopic: string | null
  onFocusTopicChange: (key: string | null) => void
}) {
  const t = useT()
  const byTopic = focusTopic !== null
  const [spaceId, setSpaceId] = useState('')
  const [chats, setChats] = useState(false)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [error, setError] = useState(false)
  const area = useElementSize()
  // Real pixels rather than a fixed drawing scaled to fit: a wider or taller screen gives the
  // nodes more room instead of magnifying them.
  const height = Math.max(MIN_HEIGHT, area.viewport - area.top - BELOW)

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
    return new Map(order.map((g, i) => [g, groupColour(i)]))
  }, [graph])

  // Topics are sorted biggest first, so the first colours go to the biggest.
  const topicIndex = useMemo(() => new Map((topics ?? []).flatMap((tp, i) => tp.members.map(m => [m.id, i] as const))), [topics])
  const focused = topics?.find(tp => tp.key === focusTopic)
  const fill = (n: LibraryGraphNode) => {
    if (!byTopic) return n.group ? colourOf.get(n.group) ?? OTHER_COLOUR : NODE_FILL[n.kind]
    const i = topicIndex.get(n.id)
    if (focused) return i !== undefined && topics![i] === focused ? groupColour(i) : DIMMED
    return i === undefined ? DIMMED : groupColour(i)
  }
  // A topic's unlinked notes are not graph nodes; say so rather than let the topic look smaller.
  const hidden = focused && graph ? focused.members.filter(m => !graph.nodes.some(n => n.id === m.id)).length : 0

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
        <select value={focusTopic === null ? 'tag' : focusTopic === '' ? 'topic' : focusTopic} aria-label={t('explore.colourBy')} className={select}
          onChange={e => onFocusTopicChange(e.target.value === 'tag' ? null : e.target.value === 'topic' ? '' : e.target.value)}>
          <option value="tag">{t('explore.colourByTag')}</option>
          <option value="topic">{t('explore.colourByTopic')}</option>
          {(topics ?? []).map(tp => <option key={tp.key} value={tp.key}>{t('explore.highlightTopic', { name: tp.name ?? tp.members[0].title })}</option>)}
        </select>
      </div>
      {byTopic && !topics && <p className="text-xs text-gray-500">{t('topics.working')}</p>}
      {hidden > 0 && <p className="text-xs text-gray-500">{t('explore.topicHidden', { count: hidden })}</p>}
      {error ? <p className="text-sm text-red-400">{t('explore.graphFailed')}</p>
        : !graph ? null
        : graph.nodes.length === 0 ? <EmptyState>{t('explore.graphEmpty')}</EmptyState>
        : (
          <>
            {graph.truncated && <p className="text-xs text-amber-400">{t('explore.truncated', { shown: graph.nodes.length, total: graph.total })}</p>}
            <div ref={area.ref}>
            {area.width > 0 && <GraphCanvas
              nodes={graph.nodes}
              edges={graph.edges}
              width={area.width}
              height={height}
              zoomable
              showLabels={(area.width * height) / graph.nodes.length >= LABEL_AREA_PER_NODE}
              fillOf={fill}
              onOpen={open}
            />}
            </div>
            {byTopic ? (
              <div className="flex flex-wrap gap-3 text-[11px] text-gray-400">
                {(topics ?? []).slice(0, GROUP_COLOURS.length).map((tp, i) => (
                  <span key={tp.key} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: groupColour(i) }} />{tp.name ?? tp.members[0].title}</span>
                ))}
                {(topics?.length ?? 0) > GROUP_COLOURS.length && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: OTHER_COLOUR }} />{t('explore.otherTopics')}</span>}
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: DIMMED }} />{t(focused ? 'explore.otherNodes' : 'explore.noTopic')}</span>
              </div>
            ) : (
            <div className="flex flex-wrap gap-3 text-[11px] text-gray-400">
              {[...colourOf].map(([g, c]) => (
                <span key={g} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: c }} />#{g}</span>
              ))}
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: NODE_FILL.note }} />{t('explore.untaggedNote')}</span>
              {chats && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: NODE_FILL.chat }} />{t('explore.chat')}</span>}
            </div>
            )}
            <EdgeLegend />
          </>
        )}
    </div>
  )
}
