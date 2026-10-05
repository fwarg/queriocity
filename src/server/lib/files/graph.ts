import { sqlite } from '../db.ts'

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
