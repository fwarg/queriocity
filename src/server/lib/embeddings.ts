import { embed, embedMany } from 'ai'
import { getEmbeddingModel } from './llm.ts'
import { timed } from './log.ts'

const EMBED_TARGET = `${process.env.EMBED_BASE_URL ?? process.env.CHAT_BASE_URL ?? process.env.BASE_URL ?? 'openai'} model=${process.env.EMBED_MODEL ?? 'nomic-embed-text'}`

/** Hard ceiling on what is sent to the embedding endpoint.
 *
 *  Embedding servers have a fixed context and reject anything over it outright — there is no
 *  graceful degradation, the call 400s and whatever depended on it fails. The text reaching here is
 *  not always chunked: a *query* embedding is the user's message, and a message carrying an inlined
 *  attachment can be hundreds of thousands of characters, which is how this was found (a 170k-char
 *  PDF summarised in one turn made every embedding call in the request fail).
 *
 *  The default leaves 2x headroom over the largest chunk this app produces (2000 chars, see
 *  files/ingest.ts) while staying inside a 1024-token server, which is what small local embedders
 *  are commonly served with. Raise it if your endpoint has a larger context. */
const EMBED_MAX_CHARS = parseInt(process.env.EMBED_MAX_CHARS ?? '', 10) || 4000

let warnedTruncation = false

function bound(text: string): string {
  if (text.length <= EMBED_MAX_CHARS) return text
  if (!warnedTruncation) {
    warnedTruncation = true
    console.warn(`  [embed] input of ${text.length} chars truncated to EMBED_MAX_CHARS=${EMBED_MAX_CHARS}. Expected for a query carrying a large attachment; if it happens for stored chunks, raise the limit.`)
  }
  return text.slice(0, EMBED_MAX_CHARS)
}

export async function embedText(text: string): Promise<number[]> {
  return timed('embed', EMBED_TARGET, async () => {
    const { embedding } = await embed({ model: getEmbeddingModel(), value: bound(text) })
    return embedding
  })
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return timed('embed', `${EMBED_TARGET} ×${texts.length}`, async () => {
    const { embeddings } = await embedMany({ model: getEmbeddingModel(), values: texts.map(bound) })
    return embeddings
  })
}

export const _test = { bound, EMBED_MAX_CHARS }
