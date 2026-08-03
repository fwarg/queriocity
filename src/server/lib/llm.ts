import { createOpenAI } from '@ai-sdk/openai'
import type { EmbeddingModel } from 'ai'

interface ProviderConfig {
  provider: string
  baseURL: string
  apiKey?: string
}

const warnedOllamaUrls = new Set<string>()

/** Ollama serves an OpenAI-compatible API at `/v1` alongside its native API at `/api`.
 *  Existing configs point at the native path (or at the bare host), so rewrite rather than
 *  fail: `*_PROVIDER=ollama` is now served by the OpenAI provider, and the dedicated
 *  ollama-ai-provider — which has no release line for AI SDK v5+ — is gone. */
export function ollamaOpenAIBase(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  if (/\/v1$/.test(trimmed)) return trimmed
  const rewritten = trimmed.replace(/\/api$/, '') + '/v1'
  if (!warnedOllamaUrls.has(baseURL)) {
    warnedOllamaUrls.add(baseURL)
    console.warn(`  [llm] ollama provider now uses the OpenAI-compatible endpoint — using ${rewritten} instead of ${baseURL}. Update your *_BASE_URL to end in /v1 to silence this.`)
  }
  return rewritten
}

function makeProvider({ provider, baseURL, apiKey }: ProviderConfig) {
  const url = provider === 'ollama' ? ollamaOpenAIBase(baseURL) : baseURL
  // Ollama ignores the key but the client requires one.
  return createOpenAI({ baseURL: url, apiKey: apiKey ?? 'sk-placeholder' })
}

// Output cap for the research/writer generations. Backstop against runaway
// (esp. thinking-model) loops; covers reasoning + answer tokens together.
export const RESEARCH_MAX_TOKENS = parseInt(process.env.RESEARCH_MAX_TOKENS ?? '6000')

const SMALL_MODEL_CONTEXT_TOKENS = parseInt(process.env.SMALL_MODEL_CONTEXT_TOKENS ?? '4096')
// Usable input budget for one small-model call, in chars: reserves 30% of its context for the
// system prompt + output, 2.5 chars/token for dense/technical text.
export const SMALL_MODEL_INPUT_CHARS = Math.floor(SMALL_MODEL_CONTEXT_TOKENS * 0.7 * 2.5)

const BASE_URL = process.env.BASE_URL
const BASE_PROVIDER = process.env.BASE_PROVIDER ?? 'openai'

const chatConfig: ProviderConfig = {
  provider: process.env.CHAT_PROVIDER ?? BASE_PROVIDER,
  baseURL: process.env.CHAT_BASE_URL ?? BASE_URL ?? 'http://localhost:11434/api',
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

const thinkingConfig: ProviderConfig = {
  provider: process.env.THINKING_PROVIDER ?? chatConfig.provider,
  baseURL: process.env.THINKING_BASE_URL ?? chatConfig.baseURL,
  apiKey: process.env.THINKING_API_KEY ?? chatConfig.apiKey,
}

const chatProvider = makeProvider(chatConfig)
const embedProvider = makeProvider(embedConfig)
const smallProvider = makeProvider(smallConfig)
const thinkingProvider = makeProvider(thinkingConfig)

// `.chat(...)` rather than `provider(...)`: from @ai-sdk/openai v2 the bare call means the
// OpenAI *Responses* API (/v1/responses), which self-hosted backends — LiteLLM, llama.cpp,
// Ollama's /v1 — do not implement. They speak Chat Completions, so pin to it explicitly.
export function getChatModel() {
  return chatProvider.chat(process.env.CHAT_MODEL ?? 'llama3.2')
}

export function getSmallModel() {
  return smallProvider.chat(process.env.SMALL_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2')
}

export function getThinkingModel() {
  return thinkingProvider.chat(process.env.THINKING_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2')
}

export function getThinkingModelOrFallback() {
  if (!process.env.THINKING_MODEL) {
    console.warn('[llm] THINKING_MODEL not set — falling back to CHAT_MODEL for thinking')
    return getChatModel()
  }
  return getThinkingModel()
}

export function getFlashModel() {
  return process.env.FLASH_MODEL === 'small' ? getSmallModel() : getChatModel()
}

export function getEmbeddingModel(): EmbeddingModel {
  const model = process.env.EMBED_MODEL ?? 'nomic-embed-text'
  return embedProvider.textEmbeddingModel(model) as EmbeddingModel
}
