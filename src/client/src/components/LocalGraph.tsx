import { useEffect, useMemo, useState } from 'react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force'
import { fetchGraph, type GraphEdge, type GraphNode } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

/** The drawing's coordinate space; the SVG scales it to the panel's width. */
const WIDTH = 360
const HEIGHT = 260
const PAD = 28
const MAX_LABEL = 18

const NODE_FILL: Record<GraphNode['kind'], string> = { note: '#fbbf24', file: '#9ca3af', chat: '#818cf8' }
const EDGE_STYLE: Record<GraphEdge['kind'], { stroke: string; dash?: string }> = {
  link: { stroke: '#6b7280' },
  derived: { stroke: '#6b7280', dash: '4 3' },
  chat: { stroke: '#6366f1', dash: '1 3' },
}

type Placed = GraphNode & { x: number; y: number }

/** A static force layout, run to rest before drawing: no animation to jank a phone, and the same
 *  input lays out the same way every time (d3 seeds positions deterministically). The root is pinned
 *  while the forces settle, then the whole drawing is fitted to the area. */
function layout(nodes: GraphNode[], edges: GraphEdge[], rootId: string): Placed[] {
  const sim = nodes.map(n => ({ ...n, ...(n.id === rootId ? { fx: 0, fy: 0 } : {}) })) as Array<GraphNode & SimulationNodeDatum>
  forceSimulation(sim)
    .force('link', forceLink<GraphNode & SimulationNodeDatum, { source: string; target: string }>(edges.map(e => ({ ...e }))).id(d => d.id).distance(70))
    .force('charge', forceManyBody().strength(-220))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide(26))
    .stop()
    .tick(300)
  const xs = sim.map(n => n.x ?? 0)
  const ys = sim.map(n => n.y ?? 0)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = Math.min((WIDTH - 2 * PAD) / Math.max(maxX - minX, 1), (HEIGHT - 2 * PAD) / Math.max(maxY - minY, 1), 1.5)
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2]
  return sim.map(n => ({ ...n, x: WIDTH / 2 + ((n.x ?? 0) - cx) * scale, y: HEIGHT / 2 + ((n.y ?? 0) - cy) * scale }))
}

const short = (label: string) => label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label

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

  useEffect(() => { fetchGraph(rootId, depth).then(setGraph).catch(() => setGraph({ nodes: [], edges: [] })) }, [rootId, depth])

  const placed = useMemo(() => graph && graph.nodes.length > 1 ? layout(graph.nodes, graph.edges, rootId) : [], [graph, rootId])
  const at = new Map(placed.map(n => [n.id, n]))

  function open(n: Placed) {
    if (n.id === rootId) return
    if (n.kind === 'chat') onOpenChat(n.id.slice('chat:'.length), n.label)
    else onOpen(n.id)
  }

  if (!graph) return null
  return (
    <div className="flex flex-col gap-1.5">
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
      {placed.length === 0 ? <p className="text-sm text-gray-500">{t('graph.empty')}</p> : (
        <>
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full max-w-xl rounded-lg bg-gray-900 border border-gray-800" role="img" aria-label={t('graph.title')}>
            {graph.edges.map((e, i) => {
              const a = at.get(e.source)
              const b = at.get(e.target)
              if (!a || !b) return null
              const style = EDGE_STYLE[e.kind]
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={style.stroke} strokeDasharray={style.dash} strokeWidth={1.2} />
            })}
            {placed.map(n => (
              <g key={n.id} onClick={() => open(n)} className={n.id === rootId ? '' : 'cursor-pointer'}>
                <title>{n.label}</title>
                {/* A larger transparent target than the dot: a finger is wider than 6px. */}
                <circle cx={n.x} cy={n.y} r={16} fill="transparent" />
                <circle cx={n.x} cy={n.y} r={n.id === rootId ? 8 : 6} fill={NODE_FILL[n.kind]} stroke={n.id === rootId ? '#fff' : 'none'} strokeWidth={2} />
                <text x={n.x} y={n.y + 18} textAnchor="middle" fontSize={9} fill={n.id === rootId ? '#f3f4f6' : '#9ca3af'}>{short(n.label)}</text>
              </g>
            ))}
          </svg>
          <div className="flex flex-wrap gap-3 text-[11px] text-gray-500">
            <Legend dash={undefined} color={EDGE_STYLE.link.stroke}>{t('graph.legendLink')}</Legend>
            <Legend dash={EDGE_STYLE.derived.dash} color={EDGE_STYLE.derived.stroke}>{t('graph.legendDerived')}</Legend>
            <Legend dash={EDGE_STYLE.chat.dash} color={EDGE_STYLE.chat.stroke}>{t('graph.legendChat')}</Legend>
          </div>
        </>
      )}
    </div>
  )
}

function Legend({ color, dash, children }: { color: string; dash?: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeDasharray={dash} strokeWidth={1.5} /></svg>
      {children}
    </span>
  )
}
