import { embed, embedMany } from 'ai'
import { getEmbeddingModel, modelTarget, targetLabel, EMBED_BATCH_CHARS, EMBED_MAX_INPUT_CHARS } from './llm.ts'
import { timed } from './log.ts'


/** How much of one string becomes one vector — a *quality* bound, see llm.ts.
 *
 *  The text reaching here is not always chunked: a query embedding is the user's message, and a
 *  message carrying an inlined attachment can be hundreds of thousands of characters. Truncating it
 *  is not merely damage control — a shorter, focused query embeds to a more discriminative vector
 *  than a long one, which averages out into something that matches everything weakly. */
const EMBED_MAX_CHARS = EMBED_MAX_INPUT_CHARS

let warnedTruncation = false

/** Removes unpaired surrogates, which cannot be encoded and fail the request rather than the string.
 *
 *  `JSON.stringify` emits a lone surrogate verbatim as `\ud83d`, and a strict JSON parser — which
 *  most embedding servers have — rejects the whole body with "invalid high surrogate in string". So
 *  one broken character anywhere in a batch of a hundred loses all hundred, and the caller sees an
 *  opaque 400 after three retries rather than anything naming the input.
 *
 *  The chunker no longer creates these (see trimOrphanSurrogates), but text also arrives here from
 *  PDF extraction, OCR and user queries, so this is the guarantee rather than the fix: nothing
 *  leaves for the server that the server cannot parse. */
const stripLoneSurrogates = (text: string): string =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')

function bound(text: string, max = EMBED_MAX_CHARS): string {
  const clean = stripLoneSurrogates(text)
  if (clean.length <= max) return clean
  if (!warnedTruncation) {
    warnedTruncation = true
    console.warn(`  [embed] input of ${clean.length} chars truncated to ${max} (EMBED_MAX_INPUT_CHARS). Expected for a query carrying a large attachment — a shorter query embeds to a sharper vector. If it fires for stored chunks, raise it.`)
  }
  // Truncation is itself a cut at a code-unit index, so it can orphan a surrogate of its own.
  return stripLoneSurrogates(clean.slice(0, max))
}

/** What a text is embedded *as*. Asymmetric retrieval models are trained on a marker telling a
 *  question from the passage that answers it, and embed each differently — so the same string needs
 *  a different prefix depending on which side of the comparison it is on.
 *
 *  - `query`: compared against stored documents (a search, a message recalling memories).
 *  - `document`: stored to be found (file and chat chunks, memories).
 *  - `similarity`: compared with its own kind (tag and topic phrases).
 *
 *  Required at every call site rather than defaulted, so a new caller has to decide which side it is. */
export type EmbedRole = 'query' | 'document' | 'similarity'

/** The configured prefix for a role, read per call like the model config. Empty unless set, which is
 *  right for symmetric models and keeps a deployment that sets none exactly as before. Similarity
 *  falls back to the query prefix: models with only query/passage markers (E5, Nemotron) put the
 *  query marker on both sides of a symmetric comparison.
 *
 *  Changing EMBED_DOCUMENT_PREFIX (or the model) makes every stored vector stale — db.ts notices and
 *  rebuilds them from stored text at the next start. */
export function embedPrefix(role: EmbedRole): string {
  const query = process.env.EMBED_QUERY_PREFIX ?? ''
  if (role === 'query') return query
  if (role === 'document') return process.env.EMBED_DOCUMENT_PREFIX ?? ''
  return process.env.EMBED_SIMILARITY_PREFIX ?? query
}

/** Prefixed and bounded, with the bound applied to the text alone so the prefix is never cut. */
function prepare(text: string, role: EmbedRole): string {
  const prefix = embedPrefix(role)
  return prefix + bound(text, Math.max(0, EMBED_MAX_CHARS - prefix.length))
}

export async function embedText(text: string, role: EmbedRole): Promise<number[]> {
  return timed('embed', targetLabel(modelTarget('embed')), async () => {
    const { embedding } = await embed({ model: getEmbeddingModel(), value: prepare(text, role) })
    return embedding
  })
}

/** Split values into batches whose *combined* size stays under the cap.
 *
 *  `embedMany` puts the whole array in one HTTP request, and an embedding server counts the tokens
 *  of that request as a whole — so bounding each string individually is not enough. Eighteen
 *  800-character chunks are each comfortably within a 1024-token context and still add up to about
 *  3600 tokens in a single call, which is rejected exactly like one oversized string. That is the
 *  shape of every indexing call this app makes, so without this the per-string cap would look
 *  correct while chat and file indexing kept failing.
 *
 *  A single value already longer than the cap is impossible here — `bound` runs first — but one is
 *  still given a batch of its own rather than being dropped. */
function batchByTotalChars(values: string[], maxChars: number): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0
  for (const v of values) {
    if (current.length && size + v.length > maxChars) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(v)
    size += v.length
  }
  if (current.length) batches.push(current)
  return batches
}

export async function embedTexts(texts: string[], role: EmbedRole): Promise<number[][]> {
  // Per string: the quality bound. Per request: the capacity bound. Two different numbers, which is
  // the whole point of the split — raising the server's context buys bigger batches without
  // quietly making each vector blurrier.
  const batches = batchByTotalChars(texts.map(t => prepare(t, role)), EMBED_BATCH_CHARS)
  return timed('embed', `${targetLabel(modelTarget('embed'))} ×${texts.length}${batches.length > 1 ? ` in ${batches.length} batches` : ''}`, async () => {
    const out: number[][] = []
    // Serial rather than parallel: these servers are usually a single local process, and firing
    // every batch at once is how a working configuration turns into timeouts under load.
    for (const values of batches) {
      const { embeddings } = await embedMany({ model: getEmbeddingModel(), values })
      out.push(...embeddings)
    }
    return out
  })
}

export const _test = { bound, prepare, batchByTotalChars, EMBED_MAX_CHARS, EMBED_BATCH_CHARS }
