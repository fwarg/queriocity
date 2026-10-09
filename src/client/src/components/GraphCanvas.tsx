import { useMemo, useRef, useState } from 'react'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force'
import type { GraphEdge, GraphNode } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

/** Drawing shared by the local graph (one resource's neighbourhood) and the library graph. */

const PAD = 28
const MAX_LABEL = 18
/** Movement below this many screen pixels is a tap on a node, not a pan. */
const DRAG_SLOP = 5

export const NODE_FILL: Record<GraphNode['kind'], string> = { note: '#fbbf24', file: '#9ca3af', chat: '#818cf8' }
export const EDGE_STYLE: Record<GraphEdge['kind'], { stroke: string; dash?: string }> = {
  link: { stroke: '#6b7280' },
  derived: { stroke: '#6b7280', dash: '4 3' },
  chat: { stroke: '#6366f1', dash: '1 3' },
}

export type Placed<N extends GraphNode = GraphNode> = N & { x: number; y: number }

/** A static force layout, run to rest before drawing: no animation to jank a phone, and the same
 *  input lays out the same way every time (d3 seeds positions deterministically). An optional root
 *  is pinned while the forces settle, then the whole drawing is fitted to the area. */
export function layout<N extends GraphNode>(nodes: N[], edges: GraphEdge[], size: { width: number; height: number }, rootId?: string): Placed<N>[] {
  const sim = nodes.map(n => ({ ...n, ...(n.id === rootId ? { fx: 0, fy: 0 } : {}) })) as Array<N & SimulationNodeDatum>
  forceSimulation(sim)
    .force('link', forceLink<N & SimulationNodeDatum, { source: string; target: string }>(edges.map(e => ({ ...e }))).id(d => d.id).distance(70))
    .force('charge', forceManyBody().strength(-220))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide(26))
    .stop()
    .tick(300)
  const xs = sim.map(n => n.x ?? 0)
  const ys = sim.map(n => n.y ?? 0)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = Math.min((size.width - 2 * PAD) / Math.max(maxX - minX, 1), (size.height - 2 * PAD) / Math.max(maxY - minY, 1), 1.5)
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2]
  return sim.map(n => ({ ...n, x: size.width / 2 + ((n.x ?? 0) - cx) * scale, y: size.height / 2 + ((n.y ?? 0) - cy) * scale }))
}

const short = (label: string) => label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label

/** The graph as SVG. With `zoomable`, it pans by dragging and zooms with buttons or the wheel —
 *  buttons rather than pinch, which a phone browser would take for zooming the page. */
export function GraphCanvas<N extends GraphNode>({ nodes, edges, width, height, rootId, fillOf, zoomable, showLabels = true, onOpen }: {
  nodes: N[]
  edges: GraphEdge[]
  width: number
  height: number
  rootId?: string
  fillOf?: (node: N) => string
  zoomable?: boolean
  /** Labels on every node; a large graph shows them only once zoomed in. */
  showLabels?: boolean
  onOpen: (node: N) => void
}) {
  const t = useT()
  const placed = useMemo(() => layout(nodes, edges, { width, height }, rootId), [nodes, edges, width, height, rootId])
  const at = new Map(placed.map(n => [n.id, n]))
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const zoom = (factor: number) => setView(v => {
    const k = Math.min(6, Math.max(0.5, v.k * factor))
    // Zoom about the centre of the drawing, so what is in view stays in view.
    return { k, x: width / 2 - (width / 2 - v.x) * (k / v.k), y: height / 2 - (height / 2 - v.y) * (k / v.k) }
  })
  const unitsPerPixel = () => width / (svgRef.current?.getBoundingClientRect().width || width)

  const pan = zoomable ? {
    onPointerDown: (e: React.PointerEvent) => { drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false } },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current
      if (!d) return
      const [dx, dy] = [e.clientX - d.px, e.clientY - d.py]
      if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
      d.moved = true
      const u = unitsPerPixel()
      setView(v => ({ ...v, x: d.x + dx * u, y: d.y + dy * u }))
    },
    onPointerUp: () => { setTimeout(() => { drag.current = null }, 0) },
    onPointerLeave: () => { drag.current = null },
    onWheel: (e: React.WheelEvent) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15),
  } : {}

  function open(n: Placed<N>) {
    if (n.id === rootId || drag.current?.moved) return
    onOpen(n)
  }

  const labels = showLabels || view.k >= 1.8
  return (
    <div className="relative">
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} {...pan}
        className={`w-full rounded-lg bg-gray-900 border border-gray-800 ${zoomable ? 'touch-none cursor-grab' : 'max-w-xl'}`}
        role="img" aria-label={t('graph.title')}>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const a = at.get(e.source)
            const b = at.get(e.target)
            if (!a || !b) return null
            const style = EDGE_STYLE[e.kind]
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={style.stroke} strokeDasharray={style.dash} strokeWidth={1.2 / view.k} />
          })}
          {placed.map(n => (
            <g key={n.id} onClick={() => open(n)} className={n.id === rootId ? '' : 'cursor-pointer'}>
              <title>{n.label}</title>
              {/* A larger transparent target than the dot: a finger is wider than 6px. */}
              <circle cx={n.x} cy={n.y} r={16 / view.k} fill="transparent" />
              <circle cx={n.x} cy={n.y} r={(n.id === rootId ? 8 : 6) / Math.sqrt(view.k)} fill={fillOf?.(n) ?? NODE_FILL[n.kind]} stroke={n.id === rootId ? '#fff' : 'none'} strokeWidth={2} />
              {labels && <text x={n.x} y={n.y + 18 / Math.sqrt(view.k)} textAnchor="middle" fontSize={9 / Math.sqrt(view.k)} fill={n.id === rootId ? '#f3f4f6' : '#9ca3af'}>{short(n.label)}</text>}
            </g>
          ))}
        </g>
      </svg>
      {zoomable && (
        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <ZoomButton label={t('graph.zoomIn')} onClick={() => zoom(1.4)}><Plus size={14} /></ZoomButton>
          <ZoomButton label={t('graph.zoomOut')} onClick={() => zoom(1 / 1.4)}><Minus size={14} /></ZoomButton>
          <ZoomButton label={t('graph.zoomReset')} onClick={() => setView({ k: 1, x: 0, y: 0 })}><RotateCcw size={14} /></ZoomButton>
        </div>
      )}
    </div>
  )
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="p-2 rounded bg-gray-800/90 border border-gray-700 text-gray-300 hover:text-white">
      {children}
    </button>
  )
}

/** Explains the three edge styles. */
export function EdgeLegend() {
  const t = useT()
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-gray-500">
      <LegendLine color={EDGE_STYLE.link.stroke}>{t('graph.legendLink')}</LegendLine>
      <LegendLine dash={EDGE_STYLE.derived.dash} color={EDGE_STYLE.derived.stroke}>{t('graph.legendDerived')}</LegendLine>
      <LegendLine dash={EDGE_STYLE.chat.dash} color={EDGE_STYLE.chat.stroke}>{t('graph.legendChat')}</LegendLine>
    </div>
  )
}

function LegendLine({ color, dash, children }: { color: string; dash?: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeDasharray={dash} strokeWidth={1.5} /></svg>
      {children}
    </span>
  )
}
