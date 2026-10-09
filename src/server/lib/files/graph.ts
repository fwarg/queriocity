import { sqlite } from '../db.ts'
import { isUnder, tagsByResource } from './tags.ts'

/** The neighbourhood of one resource: what it links to and from, what it was derived from or into,
 *  and the chat a note was saved from — a chat being the hub that ties together notes saved from it.
 *  Explicit connections only; content similarity is a suggestion, shown separately. */

export const MAX_GRAPH_NODES = 40

export type GraphNodeKind = 'note' | 'file' | 'chat'
export interface GraphNode { id: string; label: string; kind: GraphNodeKind; depth: number }
export type GraphEdgeKind = 'link' | 'derived' | 'chat'
export interface GraphEdge { source: string; target: string; kind: GraphEdgeKind }

/** Chat nodes share the id space with resources, so they are prefixed. */
export const chatNodeId = (sessionId: string) => `chat:${sessionId}`

/** Every explicit edge among a user's resources and chats. Small next to the chunk tables, so it is
 *  read whole and walked in memory rather than queried hop by hop. */
function userEdges(userId: string): GraphEdge[] {
  const links = sqlite.query(`
    SELECT DISTINCT rl.src_id AS source, rl.dst_id AS target FROM resource_links rl
    JOIN uploaded_files s ON s.id = rl.src_id JOIN uploaded_files d ON d.id = rl.dst_id
    WHERE s.user_id = ?1 AND d.user_id = ?1
  `).all(userId) as Array<{ source: string; target: string }>
  const derived = sqlite.query(`
    SELECT f.id AS source, f.derived_from AS target FROM uploaded_files f
    JOIN uploaded_files d ON d.id = f.derived_from WHERE f.user_id = ?1 AND d.user_id = ?1
  `).all(userId) as Array<{ source: string; target: string }>
  const chats = sqlite.query(`
    SELECT f.id AS source, c.id AS target FROM uploaded_files f
    JOIN chat_sessions c ON c.id = f.origin_session_id WHERE f.user_id = ?1 AND c.user_id = ?1
  `).all(userId) as Array<{ source: string; target: string }>
  return [
    ...links.map(e => ({ ...e, kind: 'link' as const })),
    ...derived.map(e => ({ ...e, kind: 'derived' as const })),
    ...chats.map(e => ({ source: e.source, target: chatNodeId(e.target), kind: 'chat' as const })),
  ]
}

/** Labels and kinds for the nodes reached. */
function describe(ids: string[]): Map<string, { label: string; kind: GraphNodeKind }> {
  const out = new Map<string, { label: string; kind: GraphNodeKind }>()
  const resourceIds = ids.filter(id => !id.startsWith('chat:'))
  const chatIds = ids.filter(id => id.startsWith('chat:')).map(id => id.slice(5))
  const marks = (n: number) => Array(n).fill('?').join(',')
  if (resourceIds.length) {
    for (const r of sqlite.query(`SELECT id, filename, kind FROM uploaded_files WHERE id IN (${marks(resourceIds.length)})`)
      .all(...resourceIds) as Array<{ id: string; filename: string; kind: 'file' | 'note' }>) out.set(r.id, { label: r.filename, kind: r.kind })
  }
  if (chatIds.length) {
    for (const c of sqlite.query(`SELECT id, title FROM chat_sessions WHERE id IN (${marks(chatIds.length)})`)
      .all(...chatIds) as Array<{ id: string; title: string }>) out.set(chatNodeId(c.id), { label: c.title, kind: 'chat' })
  }
  return out
}

/** Breadth-first from `rootId` to `depth` hops, nearest first, capped at MAX_GRAPH_NODES. The
 *  caller has checked the user owns the root. */
export function localGraph(userId: string, rootId: string, depth: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const edges = userEdges(userId)
  const neighbours = new Map<string, string[]>()
  for (const e of edges) {
    neighbours.set(e.source, [...(neighbours.get(e.source) ?? []), e.target])
    neighbours.set(e.target, [...(neighbours.get(e.target) ?? []), e.source])
  }

  const reached = new Map<string, number>([[rootId, 0]])
  let frontier = [rootId]
  for (let d = 1; d <= depth && frontier.length && reached.size < MAX_GRAPH_NODES; d++) {
    const next: string[] = []
    for (const id of frontier) for (const n of neighbours.get(id) ?? []) {
      if (reached.has(n) || reached.size >= MAX_GRAPH_NODES) continue
      reached.set(n, d)
      next.push(n)
    }
    frontier = next
  }

  const info = describe([...reached.keys()])
  const nodes = [...reached].flatMap(([id, d]) => {
    const i = info.get(id)
    return i ? [{ id, ...i, depth: d }] : []
  })
  const kept = new Set(nodes.map(n => n.id))
  return { nodes, edges: edges.filter(e => kept.has(e.source) && kept.has(e.target)) }
}

/** Cap for the whole-library graph: past this a force layout is a hairball, and a phone stalls. */
export const MAX_GLOBAL_NODES = 300

export interface GlobalGraphNode extends GraphNode {
  /** Top-level segment of the resource's first tag, for colouring; absent for chats and untagged. */
  group?: string
}

export interface GlobalGraph {
  nodes: GlobalGraphNode[]
  edges: GraphEdge[]
  /** Nodes before the cap, so the client can say how much was left out. */
  total: number
  truncated: boolean
}

/** Whole-library graph of explicit connections, optionally narrowed to a tag subtree or a space.
 *  Only connected resources appear — an isolated one says nothing in a graph (the tag tree lists
 *  them). Past the cap the best-connected nodes are kept. */
export function globalGraph(userId: string, opts: { tag?: string; spaceId?: string; includeChats?: boolean } = {}): GlobalGraph {
  const tags = tagsByResource(userId)
  const inSpace = opts.spaceId ? spaceMembers(userId, opts.spaceId) : null
  const passes = (id: string) => id.startsWith('chat:')
    ? !!opts.includeChats
    : (!opts.tag || (tags.get(id) ?? []).some(t => isUnder(t, opts.tag!))) && (!inSpace || inSpace.has(id))
  const edges = userEdges(userId).filter(e => passes(e.source) && passes(e.target))

  const degree = new Map<string, number>()
  for (const e of edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1)
  const ranked = [...degree.keys()].sort((a, b) => degree.get(b)! - degree.get(a)! || a.localeCompare(b))
  const keptIds = ranked.slice(0, MAX_GLOBAL_NODES)
  const info = describe(keptIds)
  const nodes = keptIds.flatMap(id => {
    const i = info.get(id)
    const group = tags.get(id)?.[0]?.split('/')[0]
    return i ? [{ id, ...i, depth: 0, ...(group ? { group } : {}) }] : []
  })
  const kept = new Set(nodes.map(n => n.id))
  return { nodes, edges: edges.filter(e => kept.has(e.source) && kept.has(e.target)), total: ranked.length, truncated: ranked.length > keptIds.length }
}

/** Resources of one of the user's spaces. */
function spaceMembers(userId: string, spaceId: string): Set<string> {
  return new Set((sqlite.query(`
    SELECT sf.file_id AS id FROM space_files sf JOIN uploaded_files f ON f.id = sf.file_id
    WHERE sf.space_id = ? AND f.user_id = ?
  `).all(spaceId, userId) as Array<{ id: string }>).map(r => r.id))
}

/** Resolved wikilinks in and out of each of the user's resources, for spotting unlinked notes. */
export function linkCounts(userId: string): Map<string, number> {
  const rows = sqlite.query(`
    SELECT x.rid AS id, COUNT(*) AS n FROM (
      SELECT rl.src_id AS rid FROM resource_links rl JOIN uploaded_files d ON d.id = rl.dst_id WHERE d.user_id = ?1
      UNION ALL
      SELECT rl.dst_id AS rid FROM resource_links rl JOIN uploaded_files s ON s.id = rl.src_id WHERE s.user_id = ?1 AND rl.dst_id IS NOT NULL
    ) x JOIN uploaded_files f ON f.id = x.rid WHERE f.user_id = ?1 GROUP BY x.rid
  `).all(userId) as Array<{ id: string; n: number }>
  return new Map(rows.map(r => [r.id, r.n]))
}
