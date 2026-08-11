import { embed, embedMany } from 'ai'
import { getEmbeddingModel, EMBED_BATCH_CHARS, EMBED_MAX_INPUT_CHARS } from './llm.ts'
import { timed } from './log.ts'

const EMBED_TARGET = `${process.env.EMBED_BASE_URL ?? process.env.CHAT_BASE_URL ?? process.env.BASE_URL ?? 'openai'} model=${process.env.EMBED_MODEL ?? 'nomic-embed-text'}`

/** How much of one string becomes one vector — a *quality* bound, see llm.ts.
 *
 *  The text reaching here is not always chunked: a query embedding is the user's message, and a
 *  message carrying an inlined attachment can be hundreds of thousands of characters. Truncating it
 *  is not merely damage control — a shorter, focused query embeds to a more discriminative vector
 *  than a long one, which averages out into something that matches everything weakly. */
const EMBED_MAX_CHARS = EMBED_MAX_INPUT_CHARS

let warnedTruncation = false

function bound(text: string): string {
  if (text.length <= EMBED_MAX_CHARS) return text
  if (!warnedTruncation) {
    warnedTruncation = true
    console.warn(`  [embed] input of ${text.length} chars truncated to ${EMBED_MAX_CHARS} (EMBED_MAX_INPUT_CHARS). Expected for a query carrying a large attachment — a shorter query embeds to a sharper vector. If it fires for stored chunks, raise it.`)
  }
  return text.slice(0, EMBED_MAX_CHARS)
}

export async function embedText(text: string): Promise<number[]> {
  return timed('embed', EMBED_TARGET, async () => {
    const { embedding } = await embed({ model: getEmbeddingModel(), value: bound(text) })
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

export async function embedTexts(texts: string[]): Promise<number[][]> {
  // Per string: the quality bound. Per request: the capacity bound. Two different numbers, which is
  // the whole point of the split — raising the server's context buys bigger batches without
  // quietly making each vector blurrier.
  const batches = batchByTotalChars(texts.map(bound), EMBED_BATCH_CHARS)
  return timed('embed', `${EMBED_TARGET} ×${texts.length}${batches.length > 1 ? ` in ${batches.length} batches` : ''}`, async () => {
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

export const _test = { bound, batchByTotalChars, EMBED_MAX_CHARS, EMBED_BATCH_CHARS }
