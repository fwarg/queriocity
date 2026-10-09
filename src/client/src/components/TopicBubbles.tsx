import { useCallback, useMemo } from 'react'
import type { GraphEdge, GraphNode, TopicMapData } from '../lib/api.ts'
import { groupColour } from '../lib/topic-colours.ts'
import { useElementSize } from '../lib/use-element-size.ts'
import { useT } from '../lib/i18n.tsx'
import { GraphCanvas } from './GraphCanvas.tsx'

const MIN_HEIGHT = 380
/** Room kept below the drawing for the buttons under it. */
const BELOW = 70
/** Relations below the clustering threshold by up to this much are drawn, thinner the weaker. */
const RELATION_RANGE = 0.3

type Bubble = GraphNode & { size: number; index: number }

/** The topic map from above: one bubble per topic, sized by its notes, joined to related topics.
 *  Tapping a bubble opens its notes on the note map. */
export function TopicBubbles({ data, onOpenTopic, onAllNotes }: {
  data: TopicMapData
  onOpenTopic: (key: string) => void
  onAllNotes: () => void
}) {
  const t = useT()
  const area = useElementSize()
  const height = Math.max(MIN_HEIGHT, area.viewport - area.top - BELOW)
  const nodes = useMemo<Bubble[]>(() => data.topics.map((tp, index) => ({
    id: tp.key,
    label: `${tp.name ?? tp.members[0].title} (${tp.members.length})`,
    kind: 'note',
    depth: 0,
    size: tp.members.length,
    index,
  })), [data.topics])
  const edges = useMemo<GraphEdge[]>(() => data.relations.map(r => ({
    source: r.a,
    target: r.b,
    kind: 'related',
    weight: Math.min(1, Math.max(0, (r.similarity - (data.threshold - RELATION_RANGE)) / RELATION_RANGE)),
  })), [data.relations, data.threshold])
  const radiusOf = useCallback((n: Bubble) => 8 + 3 * Math.sqrt(n.size), [])

  return (
    <div className="flex flex-col gap-2">
      <div ref={area.ref}>
        {area.width > 0 && nodes.length > 0 && (
          <GraphCanvas nodes={nodes} edges={edges} width={area.width} height={height} zoomable
            radiusOf={radiusOf} fillOf={n => groupColour(n.index)} onOpen={n => onOpenTopic(n.id)} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <button onClick={onAllNotes} className="px-2 py-1 rounded border border-gray-700 text-gray-300 hover:border-gray-500">{t('topics.allNotes')}</button>
        <span>{t('topics.bubblesLegend')}</span>
      </div>
    </div>
  )
}
