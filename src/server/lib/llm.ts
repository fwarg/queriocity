import { createOpenAI } from '@ai-sdk/openai'
import { createOllama } from 'ollama-ai-provider'
import type { EmbeddingModel } from 'ai'

interface ProviderConfig {
  provider: string
  baseURL: string
  apiKey?: string
}

function makeProvider({ provider, baseURL, apiKey }: ProviderConfig) {
  if (provider === 'ollama') {
    return createOllama({ baseURL })
  }
  return createOpenAI({ baseURL, apiKey: apiKey ?? 'sk-placeholder' })
}

const chatConfig: ProviderConfig = {
  provider: process.env.CHAT_PROVIDER ?? 'ollama',
  baseURL: process.env.CHAT_BASE_URL ?? 'http://localhost:11434/api',
  apiKey: process.env.CHAT_API_KEY,
}

const embedConfig: ProviderConfig = {
  provider: process.env.EMBED_PROVIDER ?? chatConfig.provider,
  baseURL: process.env.EMBED_BASE_URL ?? chatConfig.baseURL,
  apiKey: process.env.EMBED_API_KEY ?? chatConfig.apiKey,
}

const smallConfig: ProviderConfig = {
  provider: process.env.SMALL_PROVIDER ?? chatConfig.provider,
  baseURL: process.env.SMALL_BASE_URL ?? chatConfig.baseURL,
  apiKey: process.env.SMALL_API_KEY ?? chatConfig.apiKey,
}

const chatProvider = makeProvider(chatConfig)
const embedProvider = makeProvider(embedConfig)
const smallProvider = makeProvider(smallConfig)

export function getChatModel() {
  return chatProvider(process.env.CHAT_MODEL ?? 'llama3.2')
}

export function getSmallModel() {
  return smallProvider(process.env.SMALL_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2')
}

export function getEmbeddingModel(): EmbeddingModel<string> {
  const model = process.env.EMBED_MODEL ?? 'nomic-embed-text'
  // @ts-ignore — provider exposes .embedding() for embed models
  return (embedProvider.embedding ? embedProvider.embedding(model) : embedProvider(model)) as EmbeddingModel<string>
}
