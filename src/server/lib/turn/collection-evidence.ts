import { embedText } from '../embeddings.ts'
import { rerankEnabled, rerankScores } from '../reranker.ts'
import { exploreMinRelevance } from '../rag-settings.ts'
import { searchFile, type ChunkResult } from '../files/uploads-search.ts'
import { partOfChunk } from '../files/collection-parts.ts'

/** What an Explore turn gathers, and what of it reaches the answer: the server's first look at every
 *  document, the passages searches show, the parts read, and the notes — each held to a relevance
 *  floor where a reranker can judge one, and to a size cap. The model decides where to look; this
 *  decides what of what it saw is passed on. */

/** A search returns each document's best hits, so one document full of matches cannot crowd out
 *  another with a few: up to this many per document, best first across documents… */
const HITS_PER_DOC = 2
/** …and this many in all, scaled with the collection. */
const MIN_HITS = 8
const MAX_HITS = 30
/** Hits when searching one named document. */
const DOC_HITS = 6
const EXCERPT_CHARS = 300
/** Passages seen while exploring that reach the answer, at most this much text. */
const SEEN_MAX_CHARS = 15_000
/** Parts read that reach the answer in full, at most this much text — and at most this share of the
 *  model's room, so a small model is not swamped — the most relevant first. */
export const READ_MAX_CHARS = 20_000
export const READ_MAX_SHARE = 0.25
/** A part is scored by its best stretch of this length: the reranker reads only so much at once. */
const SCORE_WINDOW_CHARS = 1500
/** Parts are scored against the message and at most this many of the model's latest searches. */
const SCORE_QUERIES = 6

export interface Doc { label: string; fileId: string; filename: string; summary: string | null }
export interface Note { doc: string; part?: number; finding: string; quote?: string }
interface Seen { label: string; part: number; text: string }
interface Read { doc: Doc; part: number; text: string }
type Hit = { doc: Doc; row: ChunkResult }

/** What an exploration has gathered: its notes, every relevant passage a search showed it (by chunk),
 *  every part it read (by "C2:5"); and what judges relevance — the message's text and embedding, the
 *  model's searches, and the reranker's floor when there is one. */
export interface Gathered {
  notes: Note[]
  seen: Map<string, Seen>
  reads: Map<string, Read>
  locked: boolean
  task?: string
  /** The model's searches, latest last: they say what it looked for when the message does not
   *  ("can you check again?"). */
  queries: string[]
  /** Text the model ended exploring with, when it wrote findings instead of "done". */
  closing?: string
  query?: number[]
  floor?: number
}

/** The floor for what reaches the model and the answer, its own setting rather than the retrieval
 *  floor: a passage is judged against a question, and those scores run far lower than a retrieval
 *  floor tuned for injected excerpts. None without a reranker — as elsewhere, raw vector distance has
 *  no model-agnostic equivalent. */
async function relevanceFloor(): Promise<number | undefined> {
  return rerankEnabled() ? exploreMinRelevance() : undefined
}

/** The nearest chunks of each document, best hits first across documents, then second-best: every
 *  document gets its best match in before any gets a second. One document searched gets DOC_HITS. */
export function searchSpread(docs: Doc[], embedding: number[], includeConfidential: boolean): Hit[] {
  const perDoc = docs.map(doc => searchFile(doc.fileId, embedding, docs.length === 1 ? DOC_HITS : HITS_PER_DOC, includeConfidential).map(row => ({ doc, row })))
  const total = docs.length === 1 ? DOC_HITS : Math.min(MAX_HITS, Math.max(MIN_HITS, HITS_PER_DOC * docs.length))
  const ranks = Math.max(0, ...perDoc.map(h => h.length))
  return Array.from({ length: ranks }, (_, rank) => perDoc.flatMap(h => h[rank] ? [h[rank]] : []).sort((a, b) => a.row.distance - b.row.distance))
    .flat().slice(0, total)
}

/** The hits that clear the floor against `query`, and each document's best score; all hits, and no
 *  scores, when there is no floor or the reranker fails. */
export async function relevantHits(query: string, hits: Hit[], floor: number | undefined): Promise<{ kept: Hit[]; best: Map<Doc, number> }> {
  const scores = floor === undefined || !hits.length ? null : await rerankScores(query, hits.map(h => h.row.content))
  if (!scores) return { kept: hits, best: new Map() }
  const best = new Map<Doc, number>()
  hits.forEach((h, i) => best.set(h.doc, Math.max(best.get(h.doc) ?? 0, scores[i])))
  return { kept: hits.filter((_, i) => scores[i] >= floor!), best }
}

/** Each document's passages nearest the message, found by the server before the model's first step,
 *  so every document is looked at once whatever the model then decides. A document with nothing above
 *  the floor is said to have nothing close, so the model can rule it out without searching it.
 *  `search: false` skips that, for a task that covers every document whatever its wording. */
export async function firstLook(task: string, docs: Doc[], gathered: Gathered, { search = true } = {}): Promise<string> {
  try {
    gathered.task = task
    gathered.query = await embedText(task, 'query')
    gathered.floor = await relevanceFloor()
    // Without the search, only what ranks the parts read later is set.
    if (!search) return ''
    const { kept, best } = await relevantHits(task, searchSpread(docs, gathered.query, gathered.locked), gathered.floor)
    logFirstLook(docs, kept, best)
    // Nothing kept says more about how the message is worded than about the documents: a model told
    // every document has nothing close answers without searching.
    if (!kept.length) return `\n\n## A first look\nNo passage matched the message as worded. This rules no document out: search each one yourself.`
    const lines = kept.map(h => seeHit(h, gathered))
    // Only when scored: without a reranker, a document missing here was cut by the cap, not judged.
    const nothing = best.size ? docs.filter(d => !kept.some(h => h.doc === d))
      .map(d => `[${d.label}] nothing close to the message${best.has(d) ? ` (best match scored ${best.get(d)!.toFixed(2)})` : ''}`) : []
    return `\n\n## A first look: each document's passages nearest the message\n${[...lines, ...nothing].join('\n\n')}`
  } catch (e) {
    console.error('  [explore] first look failed:', e)
    return ''
  }
}

/** "first look: C1 0.15 kept, C2 0.24 kept, C3 0.01 nothing close" — which document each score was. */
function logFirstLook(docs: Doc[], kept: Hit[], best: Map<Doc, number>) {
  const each = docs.map(d => {
    const score = best.has(d) ? ` ${best.get(d)!.toFixed(2)}` : ''
    return `${d.label}${score} ${kept.some(h => h.doc === d) ? 'kept' : best.size ? 'nothing close' : 'not shown'}`
  })
  console.log(`  [explore] first look: ${each.join(', ')}`)
}

/** A search hit as the model sees it. */
export function formatHit({ doc, row }: Hit): string {
  return `[${doc.label}] part ${partOfChunk(Number(row.chunkId.split(':').pop()))}: ${row.content.slice(0, EXCERPT_CHARS)}`
}

/** A search hit as the model sees it, recorded as seen so it can reach the answer. */
export function seeHit(hit: Hit, gathered: Gathered): string {
  const { doc, row } = hit
  gathered.seen.set(row.chunkId, { label: doc.label, part: partOfChunk(Number(row.chunkId.split(':').pop())), text: row.content.slice(0, EXCERPT_CHARS) })
  return formatHit(hit)
}

export const formatNote = (n: Note) => `- [${n.doc.toUpperCase()}${n.part ? ` part ${n.part}` : ''}] ${n.finding}${n.quote ? ` — "${n.quote}"` : ''}`

/** The relevant passages searches showed, by document and part, so what the model saw but did not
 *  note still reaches the answer. */
export function seenBlock(seen: Map<string, Seen>): string {
  if (!seen.size) return ''
  const byPlace = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.part - b.part)
  let left = SEEN_MAX_CHARS
  const lines: string[] = []
  for (const s of byPlace) {
    const line = `- [${s.label} part ${s.part}] ${s.text.replace(/\s+/g, ' ')}`
    if (line.length > left) break
    left -= line.length
    lines.push(line)
  }
  return `## Passages found while exploring\n${lines.join('\n')}`
}

/** Every part read, in full, most relevant first, within `budget` characters — noted or not, since a
 *  model's notes may be a sentence where the part holds a page. A part under the floor is left out:
 *  being read does not make it relevant. */
export async function readsBlock(gathered: Gathered, budget: number): Promise<{ block: string; included: Read[] }> {
  const reads = [...gathered.reads.values()]
  if (!reads.length) return { block: '', included: [] }
  const rank = await partRanks(reads, gathered)
  const ranked = reads.filter(r => rank.has(r)).sort((a, b) => rank.get(b)! - rank.get(a)!)
  let left = budget
  const included: Read[] = []
  for (const r of ranked) {
    const size = r.text.length + 40
    if (size > left) continue
    left -= size
    included.push(r)
  }
  const block = included.length ? `## Parts read, in full\n${included.map(r => `### [${r.doc.label} part ${r.part}]\n${r.text}`).join('\n\n')}` : ''
  return { block, included }
}

/** Where relevant material was found — the documents and parts behind the notes, the passages and the
 *  parts passed on — with an instruction to account for each: a model otherwise answers from the
 *  richest document and calls the rest silent, though their passages are in front of it. */
export function evidenceBlock(gathered: Gathered, included: Read[]): string {
  const parts = new Map<string, Set<number>>()
  const add = (label: string, part?: number) => {
    const set = parts.get(label) ?? parts.set(label, new Set()).get(label)!
    if (part) set.add(part)
  }
  for (const n of gathered.notes) add(n.doc.trim().toUpperCase(), n.part)
  for (const s of gathered.seen.values()) add(s.label, s.part)
  for (const r of included) add(r.doc.label, r.part)
  if (!parts.size) return ''
  const lines = [...parts].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([label, set]) => `- ${label}${set.size ? `: part${set.size > 1 ? 's' : ''} ${[...set].sort((a, b) => a - b).join(', ')}` : ''}`)
  return `## Where relevant material was found\n${lines.join('\n')}\nAccount for each of these documents in the answer: say what it contributes, or why it does not bear on the message after all.`
}

/** How relevant each part is, higher first: the reranker's score of its best window against the
 *  message or any of the model's searches, parts under the floor absent; without a reranker, its
 *  nearest excerpt's closeness, none absent. */
async function partRanks(reads: Read[], gathered: Gathered): Promise<Map<Read, number>> {
  if (gathered.floor !== undefined && gathered.task) {
    const windows = reads.flatMap((r, i) => Array.from({ length: Math.ceil(r.text.length / SCORE_WINDOW_CHARS) }, (_, w) => ({ i, text: r.text.slice(w * SCORE_WINDOW_CHARS, (w + 1) * SCORE_WINDOW_CHARS) })))
    const scores = await bestScores(scoringQueries(gathered), windows.map(w => w.text))
    if (scores) {
      const best = new Map<Read, number>()
      windows.forEach((w, k) => best.set(reads[w.i], Math.max(best.get(reads[w.i]) ?? 0, scores[k])))
      const kept = new Map([...best].filter(([, s]) => s >= gathered.floor!))
      // None clearing it means the message scores poorly ("can you check again…"), not that every part
      // the model chose to read is unrelated: keep them all, ranked.
      if (kept.size) return kept
      console.log('  [explore] no part read cleared the floor; passing all on, ranked')
      return best
    }
  }
  return closeness(reads, gathered)
}

/** The message and the model's latest distinct searches. */
function scoringQueries(gathered: Gathered): string[] {
  return [...new Set([gathered.task!, ...gathered.queries.slice().reverse()])].slice(0, 1 + SCORE_QUERIES)
}

/** Each text's best reranker score across `queries`; null when the reranker fails for any. */
async function bestScores(queries: string[], texts: string[]): Promise<number[] | null> {
  const all = await Promise.all(queries.map(q => rerankScores(q, texts)))
  if (all.some(s => !s)) return null
  return texts.map((_, k) => Math.max(...all.map(s => s![k])))
}

/** Each part's closeness to the question by its nearest excerpt (negated distance, higher closer);
 *  all equal without an embedding. */
function closeness(reads: Read[], gathered: Gathered): Map<Read, number> {
  const out = new Map<Read, number>(reads.map(r => [r, 0]))
  if (!gathered.query) return out
  for (const fileId of new Set(reads.map(r => r.doc.fileId))) {
    const best = new Map<number, number>()
    for (const row of searchFile(fileId, gathered.query, 1000, gathered.locked)) {
      const part = partOfChunk(Number(row.chunkId.split(':').pop()))
      best.set(part, Math.min(best.get(part) ?? Infinity, row.distance))
    }
    for (const r of reads) if (r.doc.fileId === fileId) out.set(r, -(best.get(r.part) ?? Infinity))
  }
  return out
}
