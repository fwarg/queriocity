import { useEffect, useMemo, useState } from 'react'
import { fetchNoteMap, type GraphEdge, type GraphNode, type NoteMapData, type Topic } from '../lib/api.ts'
import { DIMMED, groupColour } from '../lib/topic-colours.ts'
import { useElementSize } from '../lib/use-element-size.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { EdgeLegend, GraphCanvas, type Placed } from './GraphCanvas.tsx'

const MIN_HEIGHT = 380
const BELOW = 90
/** Labels show from the start when each note has this much room (px²); otherwise once zoomed in. */
const LABEL_AREA_PER_NODE = 12_000

type Dot = GraphNode & { topic: string | null }

/** Every note (or one topic's) as a dot, joined to its most similar notes so topics settle into
 *  islands, with real links drawn too. Unlike the graph it includes notes with no links at all. */
export function TopicNoteMap({ threshold, all, topic, topics, onBack, onShowCard, onStale, onOpenResource }: {
  threshold: number
  all: boolean
  /** One topic's notes; absent for every note. */
  topic?: Topic
  /** Every topic, biggest first, so a note gets its topic's colour. */
  topics: Topic[]
  onBack: () => void
  onShowCard: (key: string) => void
  /** The topic no longer exists at this threshold: the notes changed since the map was built. */
  onStale: () => void
  onOpenResource: (id: string) => void
}) {
  const t = useT()
  const [map, setMap] = useState<NoteMapData | null>(null)
  const [error, setError] = useState('')
  const area = useElementSize()
  const height = Math.max(MIN_HEIGHT, area.viewport - area.top - BELOW)

  useEffect(() => {
    let live = true
    setMap(null)
    fetchNoteMap({ threshold, all, topic: topic?.key })
      .then(m => { if (!live) return; if (m) setMap(m); else onStale() })
      .catch(err => { if (live) setError(errorMessage(t, err, t('topics.failed'))) })
    return () => { live = false }
    // `onStale` and `t` are left out: a new function each render would refetch the map.
  }, [threshold, all, topic?.key])

  const index = useMemo(() => new Map(topics.map((tp, i) => [tp.key, i])), [topics])
  const nodes = useMemo<Dot[]>(() => (map?.nodes ?? []).map(n => ({ id: n.id, label: n.title, kind: n.kind, depth: 0, topic: n.topic })), [map])
  const edges = useMemo<GraphEdge[]>(() => [
    ...(map?.similar ?? []).map(e => ({ source: e.a, target: e.b, kind: 'similar' as const })),
    ...(map?.links ?? []).map(e => ({ source: e.a, target: e.b, kind: 'link' as const })),
  ], [map])
  const fill = (n: Dot) => {
    const i = n.topic ? index.get(n.topic) : undefined
    return i === undefined ? DIMMED : groupColour(i)
  }
  // Each topic's name at the middle of its notes — only on the all-notes map, where islands need naming.
  const names = (placed: Placed<Dot>[], zoom: number) => topic ? null : topics.map((tp, i) => {
    const mine = placed.filter(p => p.topic === tp.key)
    if (!mine.length) return null
    const x = mine.reduce((s, p) => s + p.x, 0) / mine.length
    const y = mine.reduce((s, p) => s + p.y, 0) / mine.length
    return (
      <text key={tp.key} x={x} y={y} textAnchor="middle" fontSize={12 / Math.sqrt(zoom)} fontWeight={600} fill={groupColour(i)}
        stroke="#111827" strokeWidth={3 / Math.sqrt(zoom)} paintOrder="stroke" pointerEvents="none">
        {tp.name ?? tp.members[0].title}
      </text>
    )
  })

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button onClick={onBack} className="px-2 py-1 rounded border border-gray-700 text-gray-300 hover:border-gray-500">← {t('topics.backToTopics')}</button>
        {topic && <span className="font-medium text-gray-200">{topic.name ?? topic.members[0].title}</span>}
        {topic && <button onClick={() => onShowCard(topic.key)} className="text-gray-400 hover:text-gray-200 underline">{t('topics.showCard')}</button>}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!map && !error && <p className="text-sm text-gray-400">{t('topics.working')}</p>}
      {map?.truncated && <p className="text-xs text-amber-400">{t('topics.mapTruncated', { count: map.nodes.length })}</p>}
      <div ref={area.ref}>
        {map && area.width > 0 && nodes.length > 0 && (
          <GraphCanvas nodes={nodes} edges={edges} width={area.width} height={height} zoomable
            showLabels={(area.width * height) / nodes.length >= LABEL_AREA_PER_NODE}
            fillOf={fill} overlay={names} onOpen={n => onOpenResource(n.id)} />
        )}
      </div>
      {map && (
        <div className="flex flex-wrap gap-3 text-[11px] text-gray-500">
          <span className="flex items-center gap-1"><svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke="#4b5563" strokeDasharray="2 3" strokeWidth={1.5} /></svg>{t('topics.legendSimilar')}</span>
          <EdgeLegend />
          {!topic && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: DIMMED }} />{t('explore.noTopic')}</span>}
        </div>
      )}
    </div>
  )
}
