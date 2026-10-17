import { sqlite } from '../db.ts'
import type { ModelTarget } from '../llm.ts'
import { collectResourceText } from './resource-context.ts'
import { withoutConfidential } from './confidential.ts'
import { extractOf, draftCard, type Extract } from './collection-extracts.ts'

/** Whole-collection context: every document in the picked collections rather than the excerpts
 *  nearest the question, for tasks about the collection as a whole (compare these papers, review a
 *  draft against them). A small collection goes in full. A larger one is read document by document
 *  for the task at hand (collection-extracts.ts), and the answer is written from what each says.
 *
 *  Callers must have verified ownership of the collections. */

/** Text read per document: a whole paper, not a whole book. */
const DOC_MAX_CHARS = 200_000
/** Map calls in flight on a cloud model. A local model gets one at a time: it is a single endpoint
 *  without the memory or compute to serve requests in parallel. */
const CLOUD_MAP_CONCURRENCY = 3

export interface CollectionDoc {
  fileId: string
  filename: string
  text: string
}

export interface Coverage {
  block: string
  fileSources: Array<{ title: string; url: string; label: string }>
  mode: 'full' | 'extract'
  /** Extracts were cut to fit the budget. */
  trimmed: boolean
  /** Documents read for the task that had nothing on it. */
  irrelevant: number
}

export interface CoverOptions {
  /** The answer model, which also reads each document. */
  model: ModelTarget
  /** Characters the block may take. */
  budgetChars: number
  /** Up to this many characters, the documents go in full rather than read for the task. */
  fullTextMaxChars: number
  /** The user's message without its attachments. */
  task: string
  /** The text the user attached, e.g. their own draft; its card goes into each document's call. */
  draft?: string
  abortSignal?: AbortSignal
  /** Confidential resources are read only by a locked turn. */
  includeConfidential?: boolean
  /** Called once before the first document is read and after each; not when they go in full. */
  onProgress?: (done: number, total: number) => void
}

const EMPTY: Coverage = { block: '', fileSources: [], mode: 'full', trimmed: false, irrelevant: 0 }

/** Every document in the collections, in full or as what it says about the task, sized to `budgetChars`. */
export async function coverCollection(scope: string[] | DocumentScope, opts: CoverOptions): Promise<Coverage> {
  const docs = collectionDocs(scope, opts.includeConfidential)
  if (!docs.length) return EMPTY
  const full = renderCoverage(docs, docs.map(d => d.text), 'full')
  if (full.block.length <= Math.min(opts.budgetChars, opts.fullTextMaxChars)) return { ...full, mode: 'full', trimmed: false, irrelevant: 0 }

  const card = opts.draft ? await draftCard(opts.draft, opts.model, opts.abortSignal) : ''
  const extracts: Extract[] = await mapDocs(docs, opts, doc =>
    extractOf(doc, docs.filter(d => d !== doc).map(d => d.filename), opts.task, card, opts.model, opts.abortSignal))
  const overhead = renderCoverage(docs, docs.map(() => ''), 'extract').block.length
  const fitted = fitTexts(extracts.map(e => e.text), opts.budgetChars - overhead)
  const irrelevant = extracts.filter(e => !e.relevant).length
  console.log(`  [coverage] ${docs.length} documents read for the task, ${irrelevant} with nothing on it${fitted.trimmed ? ', trimmed to fit' : ''}`)
  return { ...renderCoverage(docs, fitted.texts, 'extract'), mode: 'extract', trimmed: fitted.trimmed, irrelevant }
}

/** What a turn reads: the resources tagged to `ids` (spaces or collections) — except in
 *  `pinned.spaceId`, only the resources pinned there. A bare id list reads them all. */
export interface DocumentScope { ids: string[]; pinned?: { spaceId: string; fileIds: string[] } }

/** The resources in scope, each once, by filename. */
export function scopedFiles(scope: string[] | DocumentScope, includeConfidential: boolean): Array<{ id: string; filename: string; summary: string | null }> {
  const { ids, pinned } = Array.isArray(scope) ? { ids: scope, pinned: undefined } : scope
  if (!ids.length) return []
  const params: string[] = []
  const clauses = ids.map(id => {
    params.push(id)
    if (!pinned?.fileIds.length || id !== pinned.spaceId) return 'sf.space_id = ?'
    params.push(...pinned.fileIds)
    return `(sf.space_id = ? AND sf.file_id IN (${pinned.fileIds.map(() => '?').join(',')}))`
  })
  return sqlite.prepare(`
    SELECT DISTINCT f.id, f.filename, f.summary FROM space_files sf
    JOIN uploaded_files f ON f.id = sf.file_id
    WHERE (${clauses.join(' OR ')}) ${withoutConfidential('f.id', includeConfidential)}
    ORDER BY f.filename, f.id
  `).all(...params) as Array<{ id: string; filename: string; summary: string | null }>
}

/** The confidential resources in scope — what an unlocked turn leaves out of it. Taken from the
 *  same query that reads the scope, so pins narrow the count as they narrow the reading. */
export function confidentialInScope(scope: string[] | DocumentScope): string[] {
  const kept = new Set(scopedFiles(scope, false).map(f => f.id))
  return scopedFiles(scope, true).map(f => f.id).filter(id => !kept.has(id))
}

/** The documents in scope that have text, each once, by filename. */
export function collectionDocs(scope: string[] | DocumentScope, includeConfidential = false): CollectionDoc[] {
  return scopedFiles(scope, includeConfidential)
    .map(r => ({ fileId: r.id, filename: r.filename, text: documentText(r.id, r.filename) }))
    .filter(d => d.text)
}

/** One resource's text without the `[filename]` header collectResourceText puts before it. */
function documentText(fileId: string, filename: string): string {
  const { text } = collectResourceText([fileId], DOC_MAX_CHARS)
  const header = `\n[${filename}]\n`
  return (text.startsWith(header) ? text.slice(header.length) : text).trim()
}

/** One labelled section per document; the labels resolve to the documents as file sources. */
function renderCoverage(docs: CollectionDoc[], texts: string[], mode: Coverage['mode']) {
  const n = docs.length
  const heading = mode === 'full'
    ? `## All ${n} documents being read, in full`
    : `## What each of the ${n} documents being read says about the task`
  const sections = docs.map((d, i) => `### [C${i + 1}] ${d.filename}\n${texts[i]}`)
  const read = mode === 'full' ? '' : ' Each section was extracted from its document for this task; one saying it has nothing on the task means the document was read and found to have nothing on it. A claim about all or several documents (who wrote them, what they share) must hold in each one\'s section: check before generalising.'
  const instruction = `These are every document the user chose to read (the picked collections, and in a space its own resources), not search results: when the task concerns them, take all ${n} into account.${read} Cite a document inline by its label (e.g. [C1]); do not invent any other citation format.`
  return {
    block: [heading, ...sections, instruction].join('\n\n'),
    fileSources: docs.map((d, i) => ({ title: `[C${i + 1}] ${d.filename}`, url: `file:${d.fileId}`, label: `C${i + 1}` })),
  }
}

/** Shortens texts to fit `budget` in total: short ones stay whole and the rest share what is left equally. */
export function fitTexts(texts: string[], budget: number): { texts: string[]; trimmed: boolean } {
  if (texts.reduce((s, t) => s + t.length, 0) <= budget) return { texts, trimmed: false }
  const caps = new Array<number>(texts.length)
  let left = Math.max(0, budget)
  const byLength = texts.map((t, i) => i).sort((a, b) => texts[a].length - texts[b].length)
  byLength.forEach((i, rank) => {
    caps[i] = Math.min(texts[i].length, Math.floor(left / (texts.length - rank)))
    left -= caps[i]
  })
  return { texts: texts.map((t, i) => caps[i] < t.length ? t.slice(0, Math.max(0, caps[i] - 1)) + '…' : t), trimmed: true }
}

/** `fn` over every document, `CLOUD_MAP_CONCURRENCY` at a time on a cloud model and one at a time on a local one. */
async function mapDocs<T>(docs: CollectionDoc[], opts: CoverOptions, fn: (doc: CollectionDoc) => Promise<T>): Promise<T[]> {
  // Only cloud targets are metered, so the meter marks a model that is not on this network.
  const concurrency = opts.model.onUsage ? CLOUD_MAP_CONCURRENCY : 1
  const results = new Array<T>(docs.length)
  let next = 0
  let done = 0
  opts.onProgress?.(0, docs.length)
  const worker = async () => {
    while (next < docs.length) {
      const i = next++
      results[i] = await fn(docs[i])
      opts.onProgress?.(++done, docs.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, docs.length) }, worker))
  return results
}
