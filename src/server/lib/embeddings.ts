import { embed, embedMany } from 'ai'
import { getEmbeddingModel } from './llm.ts'
import { timed } from './log.ts'

const EMBED_TARGET = `${process.env.EMBED_BASE_URL ?? process.env.CHAT_BASE_URL ?? 'ollama'} model=${process.env.EMBED_MODEL ?? 'nomic-embed-text'}`

export async function embedText(text: string): Promise<number[]> {
  return timed('embed', EMBED_TARGET, async () => {
    const { embedding } = await embed({ model: getEmbeddingModel(), value: text })
    return embedding
  })
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return timed('embed', `${EMBED_TARGET} ×${texts.length}`, async () => {
    const { embeddings } = await embedMany({ model: getEmbeddingModel(), values: texts })
    return embeddings
  })
}
