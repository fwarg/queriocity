import { createHash } from 'node:crypto'
import { generateText } from 'ai'
import { sqlite } from '../db.ts'
import { languageModel, outputCap, localTurnModels, displayName, type ModelTarget } from '../llm.ts'
import { loadCatalogue } from '../llm-catalogue.ts'
import { meterBudgetChars } from '../trim-messages.ts'
import { ThinkExtractor } from '../think-extractor.ts'
import { LANGUAGE_RULE } from './transforms.ts'
import type { CollectionDoc } from './collection-coverage.ts'

/** Generic per-document digests: what a document is, claims, method, results, strengths and
 *  weaknesses, the same whatever the question. Cached per document and model, shown on the resource
 *  page, and the fallback when a task-aware extract (collection-extracts.ts) cannot be made. */

const DIGEST_MAX_CHARS = 1500
const DIGEST_MAX_TOKENS = 1000
/** Room for a map prompt and its answer when sizing a document for one call. */
export const MAP_PROMPT_RESERVE_CHARS = 6000

const DIGEST_SYSTEM = `You write a digest of one document, to be compared later with the other documents in a collection.
Use these headings with short bullet points, and leave out any heading the document gives nothing for:
What it is (type, topic, authors or venue if stated); Main claims; Method; Results and evidence;
Verdict or assessment (for a review: its decision and the reasons given); Strengths; Weaknesses and limitations.
At most ${DIGEST_MAX_CHARS} characters. No preamble. ${LANGUAGE_RULE}`

/** Characters of document one map call can read on this model, after `extra` characters of prompt. */
export const mapInputChars = (model: ModelTarget, extra = 0) =>
  Math.max(2000, meterBudgetChars(model.contextTokens) - MAP_PROMPT_RESERVE_CHARS - extra)

/** A document's digest: from the cache, else written by the model. A failed call falls back to the
 *  document's opening, uncached, so the document is still covered. */
export async function digestOf(doc: CollectionDoc, model: ModelTarget, abortSignal?: AbortSignal): Promise<string> {
  const input = doc.text.slice(0, mapInputChars(model))
  const key = modelKey(model)
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

/** Digests and extracts are per model: the same text read by another model gives another result. */
export const modelKey = (t: ModelTarget) => `${t.baseURL} ${t.model}`

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
  const labels = await modelLabels()
  return rows.map(r => ({
    model: labels.get(r.model) ?? r.model.slice(r.model.indexOf(' ') + 1),
    digest: r.digest,
    createdAt: Math.floor(r.created_at / 1000),
  }))
}

/** Display names by model key, for the env models and every catalogue model. */
async function modelLabels(): Promise<Map<string, string>> {
  const { chat, thinking, flash } = localTurnModels()
  const labels = new Map([chat, thinking, flash].map(t => [modelKey(t), displayName(t)]))
  const catalogue = await loadCatalogue()
  for (const m of catalogue.models) {
    const provider = catalogue.providers.find(p => p.id === m.providerId)
    if (provider) labels.set(`${provider.baseURL} ${m.model}`, m.label)
  }
  return labels
}

/** The answer text of a model that writes its reasoning inline in `<think>` tags. */
export function withoutThinking(text: string): string {
  const extractor = new ThinkExtractor()
  return (extractor.process(text).text + extractor.flush().text).trim()
}
