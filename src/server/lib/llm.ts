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

/** Two different embedding limits, which used to be one number and should not have been.
 *
 *  **EMBED_BATCH_CHARS is capacity.** How much text may go in one request, because the server counts
 *  a request's tokens as a whole and rejects anything over its context. Derived from the declared
 *  context the same way the two models above work — say what the server was started with, let the
 *  app do the arithmetic. Bigger is purely a throughput win: more chunks per round trip.
 *
 *  **EMBED_MAX_INPUT_CHARS is quality.** How much of a *single* string becomes one vector. This is
 *  not a capacity question at all: embedding a long passage averages it into a blurry vector that
 *  discriminates poorly, so the retrieval literature lands on roughly 512 tokens per vector and
 *  warns against pushing toward a model's ceiling. It matters for queries, which are never chunked —
 *  a message carrying an inlined attachment would otherwise be embedded whole.
 *
 *  Tying them together was a design error: raising the context for indexing throughput silently
 *  raised how much of a query became one vector, which makes retrieval worse. They now move
 *  independently, with the one dependency that a single string cannot exceed a whole request.
 *
 *  ~2500 chars is about 600 tokens at 4 chars/token — inside the 512–1024 band the research
 *  recommends, and above the 2000-char chunks in files/ingest.ts so stored vectors are never
 *  clipped. */
const EMBED_CONTEXT_TOKENS = parseInt(process.env.EMBED_CONTEXT_TOKENS ?? '', 10) || 1024
export const EMBED_BATCH_CHARS = Math.floor(EMBED_CONTEXT_TOKENS * 0.9 * 2.5)

// EMBED_MAX_CHARS is the superseded name; honoured so an existing setting keeps working, and it
// only ever governed the per-string bound in practice.
const EMBED_QUALITY_CHARS =
  parseInt(process.env.EMBED_MAX_INPUT_CHARS ?? process.env.EMBED_MAX_CHARS ?? '', 10) || 2500

export const EMBED_MAX_INPUT_CHARS = Math.min(EMBED_QUALITY_CHARS, EMBED_BATCH_CHARS)

// Config is resolved per call, not at module load. A module-level const captures whatever the
// environment held when the first importer pulled this in, which makes the value depend on
// import order — the same trap searxng.ts documents, and the reason a test could not point the
// chat model at a stub server. Providers are memoised per resolved target so the per-call cost
// stays a Map lookup.
const chatConfig = (): ProviderConfig => ({
  provider: process.env.CHAT_PROVIDER ?? process.env.BASE_PROVIDER ?? 'openai',
  baseURL: process.env.CHAT_BASE_URL ?? process.env.BASE_URL ?? 'http://localhost:11434/api',
  apiKey: process.env.CHAT_API_KEY,
})

const embedConfig = (): ProviderConfig => {
  const chat = chatConfig()
  return {
    provider: process.env.EMBED_PROVIDER ?? chat.provider,
    baseURL: process.env.EMBED_BASE_URL ?? chat.baseURL,
    apiKey: process.env.EMBED_API_KEY ?? chat.apiKey,
  }
}

const smallConfig = (): ProviderConfig => {
  const chat = chatConfig()
  return {
    provider: process.env.SMALL_PROVIDER ?? chat.provider,
    baseURL: process.env.SMALL_BASE_URL ?? chat.baseURL,
    apiKey: process.env.SMALL_API_KEY ?? chat.apiKey,
  }
}

const thinkingConfig = (): ProviderConfig => {
  const chat = chatConfig()
  return {
    provider: process.env.THINKING_PROVIDER ?? chat.provider,
    baseURL: process.env.THINKING_BASE_URL ?? chat.baseURL,
    apiKey: process.env.THINKING_API_KEY ?? chat.apiKey,
  }
}

const providers = new Map<string, ReturnType<typeof createOpenAI>>()
function provider(config: ProviderConfig) {
  const key = `${config.provider}|${config.baseURL}|${config.apiKey ?? ''}`
  let p = providers.get(key)
  if (!p) {
    p = makeProvider(config)
    providers.set(key, p)
  }
  return p
}

// `.chat(...)` rather than `provider(...)`: from @ai-sdk/openai v2 the bare call means the
// OpenAI *Responses* API (/v1/responses), which self-hosted backends — LiteLLM, llama.cpp,
// Ollama's /v1 — do not implement. They speak Chat Completions, so pin to it explicitly.
export function getChatModel() {
  return provider(chatConfig()).chat(process.env.CHAT_MODEL ?? 'llama3.2')
}

export function getSmallModel() {
  return provider(smallConfig()).chat(process.env.SMALL_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2')
}

export function getThinkingModel() {
  return provider(thinkingConfig()).chat(process.env.THINKING_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2')
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
  return provider(embedConfig()).textEmbeddingModel(model) as EmbeddingModel
}
