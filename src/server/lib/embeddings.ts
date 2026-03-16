import { embed, embedMany } from 'ai'
import { getLLM } from './llm.ts'

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text'

function getEmbeddingModel() {
  // Uses same provider as chat but embedding-specific model
  const provider = getLLM()
  // @ts-ignore — provider has createEmbeddingModel
  return provider.embedding(EMBEDDING_MODEL)
}

export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: text,
  })
  return embedding
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(),
    values: texts,
  })
  return embeddings
}
