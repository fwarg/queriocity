import { createOpenAI } from '@ai-sdk/openai'
import { createOllama } from 'ollama-ai-provider'

/** Returns a configured provider instance based on env vars. */
export function getLLM() {
  const provider = process.env.LLM_PROVIDER ?? 'ollama'

  if (provider === 'ollama') {
    return createOllama({ baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/api' })
  }

  // OpenAI-compatible (LM Studio, Lemonade, OpenAI, etc.)
  return createOpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY ?? 'sk-placeholder',
  })
}

export function getChatModel() {
  const model = process.env.LLM_MODEL ?? 'llama3.2'
  return getLLM()(model)
}
