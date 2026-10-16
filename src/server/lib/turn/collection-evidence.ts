import { embedText } from '../embeddings.ts'
import { rerankEnabled, rerankScores } from '../reranker.ts'
import { ragMinRelevance } from '../rag-settings.ts'
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

export interface Doc { label: string; fileId: string; filename: string; summary: string | null }
export interface Note { doc: string; part?: number; finding: string; quote?: string }
interface Seen { label: string; part: number; text: string }
interface Read { doc: Doc; part: number; text: string }
type Hit = { doc: Doc; row: ChunkResult }

/** What an exploration has gathered: its notes, every relevant passage a search showed it (by chunk),
 *  every part it read (by "C2:5"); and what judges relevance — the message's text and embedding, and
 *  the reranker's floor when there is one. */
export interface Gathered {
  notes: Note[]
  seen: Map<string, Seen>
  reads: Map<string, Read>
  locked: boolean
  task?: string
  query?: number[]
  floor?: number
}

/** Below this reranker score a passage is taken as unrelated. Question-to-passage scores run low,
 *  far lower than document-to-document "similar content" ones: in a real run, relevant passages
 *  scored 0.15–0.86 against a conversational question and unrelated ones 0.035 or less. A floor of 0.5,
 *  borrowed from similar content, discarded every relevant passage. */
const EXPLORE_MIN_RELEVANCE = 0.05

/** The floor for what reaches the model and the answer: EXPLORE_MIN_RELEVANCE, or the retrieval floor
 *  (`rag_min_relevance`) when an admin set that higher, when a reranker is configured; none without —
 *  as elsewhere, raw vector distance has no model-agnostic equivalent. */
async function relevanceFloor(): Promise<number | undefined> {
  return rerankEnabled() ? Math.max(EXPLORE_MIN_RELEVANCE, await ragMinRelevance()) : undefined
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
 *  the floor is said to have nothing close, so the model can rule it out without searching it. */
export async function firstLook(task: string, docs: Doc[], gathered: Gathered): Promise<string> {
  try {
    gathered.task = task
    gathered.query = await embedText(task)
    gathered.floor = await relevanceFloor()
    const { kept, best } = await relevantHits(task, searchSpread(docs, gathered.query, gathered.locked), gathered.floor)
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

/** A search hit as the model sees it, recorded as seen so it can reach the answer. */
export function seeHit({ doc, row }: Hit, gathered: Gathered): string {
  const part = partOfChunk(Number(row.chunkId.split(':').pop()))
  const text = row.content.slice(0, EXCERPT_CHARS)
  gathered.seen.set(row.chunkId, { label: doc.label, part, text })
  return `[${doc.label}] part ${part}: ${text}`
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
export async function readsBlock(gathered: Gathered, budget: number): Promise<string> {
  const reads = [...gathered.reads.values()]
  if (!reads.length) return ''
  const rank = await partRanks(reads, gathered)
  const ranked = reads.filter(r => rank.has(r)).sort((a, b) => rank.get(b)! - rank.get(a)!)
  let left = budget
  const sections: string[] = []
  for (const r of ranked) {
    const section = `### [${r.doc.label} part ${r.part}]\n${r.text}`
    if (section.length > left) continue
    left -= section.length
    sections.push(section)
  }
  return sections.length ? `## Parts read, in full\n${sections.join('\n\n')}` : ''
}

/** How relevant each part is, higher first: the reranker's score of its best window, parts under the
 *  floor absent; without a reranker, its nearest excerpt's closeness, none absent. */
async function partRanks(reads: Read[], gathered: Gathered): Promise<Map<Read, number>> {
  if (gathered.floor !== undefined && gathered.task) {
    const windows = reads.flatMap((r, i) => Array.from({ length: Math.ceil(r.text.length / SCORE_WINDOW_CHARS) }, (_, w) => ({ i, text: r.text.slice(w * SCORE_WINDOW_CHARS, (w + 1) * SCORE_WINDOW_CHARS) })))
    const scores = await rerankScores(gathered.task, windows.map(w => w.text))
    if (scores) {
      const best = new Map<Read, number>()
      windows.forEach((w, k) => best.set(reads[w.i], Math.max(best.get(reads[w.i]) ?? 0, scores[k])))
      return new Map([...best].filter(([, s]) => s >= gathered.floor!))
    }
  }
  return closeness(reads, gathered)
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
