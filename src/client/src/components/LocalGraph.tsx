import { useEffect, useState } from 'react'
import { useElementSize } from '../lib/use-element-size.ts'
import { fetchGraph, type GraphEdge, type GraphNode } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { EdgeLegend, GraphCanvas } from './GraphCanvas.tsx'

const HEIGHT = 260

/** The resource's explicit neighbourhood — links, notes made from it, the chat a note came from — as
 *  a small diagram. Tapping a node opens it; one or two steps out. */
export function LocalGraph({ rootId, onOpen, onOpenChat }: {
  rootId: string
  onOpen: (id: string) => void
  onOpenChat: (id: string, title: string) => void
}) {
  const t = useT()
  const [depth, setDepth] = useState<1 | 2>(1)
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)
  const area = useElementSize()

  useEffect(() => { fetchGraph(rootId, depth).then(setGraph).catch(() => setGraph({ nodes: [], edges: [] })) }, [rootId, depth])

  function open(n: GraphNode) {
    if (n.kind === 'chat') onOpenChat(n.id.slice('chat:'.length), n.label)
    else onOpen(n.id)
  }

  if (!graph) return null
  return (
    <div ref={area.ref} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">{t('graph.title')}</h3>
        <div className="flex gap-1">
          {([1, 2] as const).map(d => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              aria-pressed={depth === d}
              className={`px-2 py-1 rounded text-xs border ${depth === d ? 'bg-gray-700 text-gray-100 border-gray-500' : 'text-gray-400 border-gray-700 hover:text-gray-200'}`}
            >
              {t('graph.depth', { count: d })}
            </button>
          ))}
        </div>
      </div>
      {graph.nodes.length <= 1 ? <p className="text-sm text-gray-500">{t('graph.empty')}</p> : (
        <>
          {/* Drawn in the panel's own pixels: full width, fixed height, text the same size everywhere. */}
          {area.width > 0 && <GraphCanvas nodes={graph.nodes} edges={graph.edges} width={area.width} height={HEIGHT} rootId={rootId} onOpen={open} />}
          <EdgeLegend />
        </>
      )}
    </div>
  )
}
