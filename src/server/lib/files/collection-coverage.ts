import { createHash } from 'node:crypto'
import { generateText } from 'ai'
import { sqlite } from '../db.ts'
import { languageModel, outputCap, localTurnModels, displayName, type ModelTarget } from '../llm.ts'
import { loadCatalogue } from '../llm-catalogue.ts'
import { meterBudgetChars } from '../trim-messages.ts'
import { ThinkExtractor } from '../think-extractor.ts'
import { collectResourceText } from './resource-context.ts'
import { LANGUAGE_RULE } from './transforms.ts'

/** Whole-collection context: every document in the picked collections rather than the excerpts
 *  nearest the question, for tasks about the collection as a whole (compare these papers, review a
 *  draft against them). The documents go in full when they fit the answer model's budget; otherwise
 *  each is first reduced to a digest by that same model (map → reduce), cached per document and model.
 *
 *  Callers must have verified ownership of the collections. */

/** Text read per document: a whole paper, not a whole book. */
const DOC_MAX_CHARS = 200_000
const DIGEST_MAX_CHARS = 1500
const DIGEST_MAX_TOKENS = 1000
/** Room for the digest prompt and its answer when sizing a document for the map call. */
const DIGEST_PROMPT_RESERVE_CHARS = 6000
/** Map calls in flight on a cloud model. A local model gets one at a time: it is a single endpoint
 *  without the memory or compute to serve requests in parallel. */
const CLOUD_MAP_CONCURRENCY = 3

const DIGEST_SYSTEM = `You write a digest of one document, to be compared later with the other documents in a collection.
Use these headings with short bullet points, and leave out any heading the document gives nothing for:
What it is (type, topic, authors or venue if stated); Main claims; Method; Results and evidence;
Verdict or assessment (for a review: its decision and the reasons given); Strengths; Weaknesses and limitations.
At most ${DIGEST_MAX_CHARS} characters. No preamble. ${LANGUAGE_RULE}`

export interface CollectionDoc {
  fileId: string
  filename: string
  text: string
}

export interface Coverage {
  block: string
  fileSources: Array<{ title: string; url: string; label: string }>
  mode: 'full' | 'digest'
  /** Digests were cut to fit the budget. */
  trimmed: boolean
}

export interface CoverOptions {
  /** The answer model, which also writes the digests. */
  model: ModelTarget
  /** Characters the block may take. */
  budgetChars: number
  abortSignal?: AbortSignal
  /** Called once before the first digest and after each; not at all when the documents go in full. */
  onProgress?: (done: number, total: number) => void
}

const EMPTY: Coverage = { block: '', fileSources: [], mode: 'full', trimmed: false }

/** Every document in the collections, in full or as digests, sized to `budgetChars`. */
export async function coverCollection(collectionIds: string[], opts: CoverOptions): Promise<Coverage> {
  const docs = collectionDocs(collectionIds)
  if (!docs.length) return EMPTY
  const full = renderCoverage(docs, docs.map(d => d.text), 'full')
  if (full.block.length <= opts.budgetChars) return { ...full, mode: 'full', trimmed: false }

  const digests = await digestAll(docs, opts)
  const overhead = renderCoverage(docs, docs.map(() => ''), 'digest').block.length
  const fitted = fitTexts(digests, opts.budgetChars - overhead)
  console.log(`  [coverage] ${docs.length} documents as digests${fitted.trimmed ? ', trimmed to fit' : ''}`)
  return { ...renderCoverage(docs, fitted.texts, 'digest'), mode: 'digest', trimmed: fitted.trimmed }
}

/** The documents in these collections that have text, each once, by filename. */
export function collectionDocs(collectionIds: string[]): CollectionDoc[] {
  if (!collectionIds.length) return []
  const rows = sqlite.prepare(`
    SELECT DISTINCT f.id, f.filename FROM space_files sf
    JOIN uploaded_files f ON f.id = sf.file_id
    WHERE sf.space_id IN (${collectionIds.map(() => '?').join(',')})
    ORDER BY f.filename, f.id
  `).all(...collectionIds) as Array<{ id: string; filename: string }>
  return rows
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
    ? `## All ${n} documents in the selected collections, in full`
    : `## Digests of all ${n} documents in the selected collections`
  const sections = docs.map((d, i) => `### [C${i + 1}] ${d.filename}\n${texts[i]}`)
  const instruction = `These are every document in the collections the user selected, not search results: when the task concerns the collection, take all ${n} into account. Cite a document inline by its label (e.g. [C1]); do not invent any other citation format.`
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

/** Digests of every document, made `CLOUD_MAP_CONCURRENCY` at a time on a cloud model and one at a time on a local one. */
async function digestAll(docs: CollectionDoc[], opts: CoverOptions): Promise<string[]> {
  // Only cloud targets are metered, so the meter marks a model that is not on this network.
  const concurrency = opts.model.onUsage ? CLOUD_MAP_CONCURRENCY : 1
  const digests = new Array<string>(docs.length)
  let next = 0
  let done = 0
  opts.onProgress?.(0, docs.length)
  const worker = async () => {
    while (next < docs.length) {
      const i = next++
      digests[i] = await digestOf(docs[i], opts)
      opts.onProgress?.(++done, docs.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, docs.length) }, worker))
  return digests
}

/** A document's digest: from the cache, else written by the model. A failed call falls back to the
 *  document's opening, uncached, so the document is still covered. */
async function digestOf(doc: CollectionDoc, { model, abortSignal }: CoverOptions): Promise<string> {
  const input = doc.text.slice(0, Math.max(2000, meterBudgetChars(model.contextTokens) - DIGEST_PROMPT_RESERVE_CHARS))
  const key = digestKey(model)
  const hash = createHash('sha256').update(DIGEST_SYSTEM).update('\0').update(input).digest('hex')
  const cached = sqlite.prepare('SELECT digest FROM resource_digests WHERE file_id = ? AND model = ? AND text_hash = ?')
    .get(doc.fileId, key, hash) as { digest: string } | null
  if (cached) return cached.digest
  try {
    const { text } = await generateText({
      model: languageModel(model),
      system: DIGEST_SYSTEM,
      prompt: `Document: ${doc.filename}\n\n${input}`,
      maxOutputTokens: outputCap(model, DIGEST_MAX_TOKENS),
      abortSignal,
    })
    const digest = withoutThinking(text).slice(0, DIGEST_MAX_CHARS * 2)
    if (!digest) throw new Error('empty digest')
    sqlite.prepare('INSERT OR REPLACE INTO resource_digests(file_id, model, text_hash, digest, created_at) VALUES (?,?,?,?,?)')
      .run(doc.fileId, key, hash, digest, Date.now())
    return digest
  } catch (e) {
    if (abortSignal?.aborted) throw e
    console.error(`  [coverage] digest of ${doc.filename} failed:`, e)
    return doc.text.slice(0, DIGEST_MAX_CHARS) + '…'
  }
}

/** Digests are per model: the same text digested by another model is another digest. */
const digestKey = (t: ModelTarget) => `${t.baseURL} ${t.model}`

export interface StoredDigest {
  /** The model's display name where it is still configured, else its model name. */
  model: string
  digest: string
  /** Epoch seconds. */
  createdAt: number
}

/** A resource's stored digests, newest first, for showing in its detail view. */
export async function storedDigests(fileId: string): Promise<StoredDigest[]> {
  const rows = sqlite.prepare('SELECT model, digest, created_at FROM resource_digests WHERE file_id = ? ORDER BY created_at DESC')
    .all(fileId) as Array<{ model: string; digest: string; created_at: number }>
  if (!rows.length) return []
  const labels = await digestModelLabels()
  return rows.map(r => ({
    model: labels.get(r.model) ?? r.model.slice(r.model.indexOf(' ') + 1),
    digest: r.digest,
    createdAt: Math.floor(r.created_at / 1000),
  }))
}

/** Display names by digest key, for the env models and every catalogue model. */
async function digestModelLabels(): Promise<Map<string, string>> {
  const { chat, thinking, flash } = localTurnModels()
  const labels = new Map([chat, thinking, flash].map(t => [digestKey(t), displayName(t)]))
  const catalogue = await loadCatalogue()
  for (const m of catalogue.models) {
    const provider = catalogue.providers.find(p => p.id === m.providerId)
    if (provider) labels.set(`${provider.baseURL} ${m.model}`, m.label)
  }
  return labels
}

/** The answer text of a model that writes its reasoning inline in `<think>` tags. */
function withoutThinking(text: string): string {
  const extractor = new ThinkExtractor()
  return (extractor.process(text).text + extractor.flush().text).trim()
}
