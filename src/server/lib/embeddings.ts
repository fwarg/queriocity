import { embed, embedMany } from 'ai'
import { getEmbeddingModel } from './llm.ts'

export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: getEmbeddingModel(), value: text })
  return embedding
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({ model: getEmbeddingModel(), values: texts })
  return embeddings
}
