import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel, type EmbeddingModel, type LanguageModelMiddleware } from 'ai'

interface ProviderConfig {
  provider: string
  baseURL: string
  apiKey?: string
  /** Fields merged into every request body; the request's own fields win. */
  extraBody?: Record<string, unknown>
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

function makeProvider({ provider, baseURL, apiKey, extraBody }: ProviderConfig) {
  const url = provider === 'ollama' ? ollamaOpenAIBase(baseURL) : baseURL
  // Ollama ignores the key but the client requires one.
  return createOpenAI({ baseURL: url, apiKey: apiKey ?? 'sk-placeholder', ...(extraBody && { fetch: withExtraBody(extraBody) }) })
}

/** A fetch that adds provider-specific fields to each JSON request body; the SDK has no option for them. */
function withExtraBody(extra: Record<string, unknown>): typeof fetch {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') return fetch(input, init)
    let body: unknown
    try { body = JSON.parse(init.body) } catch { return fetch(input, init) }
    return fetch(input, { ...init, body: JSON.stringify({ ...extra, ...(body as object) }) })
  }
  return Object.assign(wrapped, { preconnect: fetch.preconnect })
}

// Output cap for the research/writer generations. Backstop against runaway
// (esp. thinking-model) loops; covers reasoning + answer tokens together.
export const RESEARCH_MAX_TOKENS = parseInt(process.env.RESEARCH_MAX_TOKENS ?? '6000')

/** Default `memory_token_budget` when the admin setting is unset: how many tokens of space memory
 *  may go into a prompt. Sized for the richer 1-3 sentence notes the extractor now writes; the
 *  reranker keeps only the most relevant ones, so a larger store does not mean a larger prompt. */
export const DEFAULT_MEMORY_TOKEN_BUDGET = '1500'

/** The one token↔char conversion in the app. Every context budget derives from it.
 *
 *  There were two: 2.5 for the small-model and embedding capacity ceilings, 4 for the chat model's
 *  trimming budget. Both are guesses about the same thing, and where 2.5 was used it stacked on top
 *  of a reserve fraction that already carries the safety margin — the small model was handed 44% of
 *  its declared window while the comment beside it claimed 70%.
 *
 *  4 is the ordinary figure for English prose under a BPE tokenizer, and it is what the reserve
 *  fractions below were written to sit on top of. Dense technical text, code and non-English tokenize
 *  worse (nearer 3); lower this if a server starts rejecting requests as over-context, rather than
 *  re-introducing a second ratio somewhere. */
export const CHARS_PER_TOKEN = parseFloat(process.env.CHARS_PER_TOKEN ?? '') || 4

/** Token count of a string, and its inverse. Rounded in the direction that costs budget, so a
 *  sequence of estimates can only over-report. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN)
export const tokensToChars = (tokens: number): number => Math.floor(tokens * CHARS_PER_TOKEN)

export type ModelRole = 'chat' | 'small' | 'thinking' | 'embed'

const CONTEXT_ENV: Record<ModelRole, string> = {
  chat: 'CONTEXT_TOKEN_LIMIT', small: 'SMALL_MODEL_CONTEXT_TOKENS', thinking: 'CONTEXT_TOKEN_LIMIT', embed: 'EMBED_CONTEXT_TOKENS',
}
// The thinking model has no context setting of its own; it shares the chat model's.
const DEFAULT_CONTEXT_TOKENS: Record<ModelRole, number> = { chat: 8192, small: 4096, thinking: 8192, embed: 1024 }

/** Declared context window of a role's model, in tokens. */
const contextTokensFor = (role: ModelRole): number =>
  parseInt(process.env[CONTEXT_ENV[role]] ?? '', 10) || DEFAULT_CONTEXT_TOKENS[role]

const SMALL_MODEL_CONTEXT_TOKENS = contextTokensFor('small')
// Usable input budget for one small-model call, in chars: reserves 30% of its context for the
// system prompt + output.
export const SMALL_MODEL_INPUT_CHARS = Math.floor(SMALL_MODEL_CONTEXT_TOKENS * 0.7 * CHARS_PER_TOKEN)

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
 *  ~2500 chars is about 600 tokens at CHARS_PER_TOKEN — inside the 512–1024 band the research
 *  recommends, and above the 2000-char chunks in files/ingest.ts so stored vectors are never
 *  clipped. */
const EMBED_CONTEXT_TOKENS = contextTokensFor('embed')
export const EMBED_BATCH_CHARS = Math.floor(EMBED_CONTEXT_TOKENS * 0.9 * CHARS_PER_TOKEN)

// EMBED_MAX_CHARS is the superseded name; honoured so an existing setting keeps working, and it
// only ever governed the per-string bound in practice.
const EMBED_QUALITY_CHARS =
  parseInt(process.env.EMBED_MAX_INPUT_CHARS ?? process.env.EMBED_MAX_CHARS ?? '', 10) || 2500

export const EMBED_MAX_INPUT_CHARS = Math.min(EMBED_QUALITY_CHARS, EMBED_BATCH_CHARS)

// Config is resolved per call, not at module load. A module-level const captures whatever the
// environment held when the first importer pulled this in, which makes the value depend on
// import order — the same trap search/providers/searxng.ts documents, and the reason a test could not point the
// chat model at a stub server. Providers are memoised per resolved target so the per-call cost
// stays a Map lookup.
export const DEFAULT_BASE_URL = 'http://localhost:11434/api'
export const DEFAULT_CHAT_MODEL = 'llama3.2'
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text'

/** Where a role's model lives and what it is. The one place model env vars are read. */
export interface ModelTarget extends ProviderConfig {
  role: ModelRole
  model: string
  contextTokens: number
  /** The role names its own model rather than borrowing the chat model (or the embed default). */
  configured: boolean
  /** Called with each call's token usage; set for metered (cloud) targets only. */
  onUsage?: (usage: TokenUsage) => void
  /** Output cap from the catalogue; unset for env models, which use the caller's default. */
  maxOutputTokens?: number
}

/** A call's output cap: the target's own when the catalogue sets one, else the caller's default.
 *  Reasoning models spend output tokens before answering, so a cloud entry may need far more. */
export const outputCap = (t: ModelTarget, fallback: number): number => t.maxOutputTokens ?? fallback

export interface TokenUsage {
  inputTokens: number
  /** Includes reasoning tokens, which providers bill as output. */
  outputTokens: number
}

const ROLE_ENV_PREFIX: Record<Exclude<ModelRole, 'chat'>, string> = { small: 'SMALL', thinking: 'THINKING', embed: 'EMBED' }

function chatTarget(): ModelTarget {
  return {
    role: 'chat',
    provider: process.env.CHAT_PROVIDER ?? process.env.BASE_PROVIDER ?? 'openai',
    baseURL: process.env.CHAT_BASE_URL ?? process.env.BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: process.env.CHAT_API_KEY,
    model: process.env.CHAT_MODEL ?? DEFAULT_CHAT_MODEL,
    contextTokens: contextTokensFor('chat'),
    configured: true,
  }
}

/** A role's resolved model config; every unset field falls back to the chat model's. */
export function modelTarget(role: ModelRole): ModelTarget {
  const chat = chatTarget()
  if (role === 'chat') return chat
  const prefix = ROLE_ENV_PREFIX[role]
  const model = process.env[`${prefix}_MODEL`]
  return {
    role,
    provider: process.env[`${prefix}_PROVIDER`] ?? chat.provider,
    baseURL: process.env[`${prefix}_BASE_URL`] ?? chat.baseURL,
    apiKey: process.env[`${prefix}_API_KEY`] ?? chat.apiKey,
    model: model ?? (role === 'embed' ? DEFAULT_EMBED_MODEL : chat.model),
    contextTokens: contextTokensFor(role),
    configured: model !== undefined,
  }
}

/** Every role's target, for startup logs, admin checks and the locked-space warning. */
export const describeModels = (): ModelTarget[] =>
  (['chat', 'small', 'thinking', 'embed'] as const).map(role => modelTarget(role))

/** Short `<url> model=<name>` label for log lines. */
export const targetLabel = (t: ModelTarget): string => `${t.baseURL} model=${t.model}`

/** The model flash mode runs on: the small model when FLASH_MODEL=small, else the chat model. */
export const flashTarget = (): ModelTarget => modelTarget(process.env.FLASH_MODEL === 'small' ? 'small' : 'chat')

const providers = new Map<string, ReturnType<typeof createOpenAI>>()
function provider(config: ProviderConfig) {
  const key = `${config.provider}|${config.baseURL}|${config.apiKey ?? ''}|${JSON.stringify(config.extraBody ?? null)}`
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
export function languageModel(t: ModelTarget) {
  const model = provider(t).chat(t.model)
  return t.onUsage ? wrapLanguageModel({ model, middleware: usageMiddleware(t.onUsage) }) : model
}

/** Reports each call's usage once it is known: from the result, or from a stream's finish part.
 *  At the model layer rather than per call site, so every step of a tool loop is counted. */
function usageMiddleware(onUsage: (u: TokenUsage) => void): LanguageModelMiddleware {
  const report = (u: { inputTokens: { total: number | undefined }; outputTokens: { total: number | undefined } }) => {
    try {
      onUsage({ inputTokens: u.inputTokens.total ?? 0, outputTokens: u.outputTokens.total ?? 0 })
    } catch (e) {
      console.error('  [llm] usage recording failed:', e)
    }
  }
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      report(result.usage)
      return result
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream()
      const stream = result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === 'finish') report(part.usage)
          controller.enqueue(part)
        },
      }))
      return { ...result, stream }
    },
  }
}

/** Background helpers (titles, reformulation, memory, summaries) use these and always run locally. */
export const getChatModel = () => languageModel(modelTarget('chat'))
export const getSmallModel = () => languageModel(modelTarget('small'))
export const getThinkingModel = () => languageModel(modelTarget('thinking'))
export const getFlashModel = () => languageModel(flashTarget())

/** The models that answer one user turn. Resolved once per request and passed down, so a turn can
 *  run on a different model than the background helpers — the hook for per-request model choice. */
export interface TurnModels {
  chat: ModelTarget
  /** The chat model when no thinking model is configured. */
  thinking: ModelTarget
  flash: ModelTarget
}

/** The env-configured local models for a turn: the default, and the only set monitors use. */
export function localTurnModels(): TurnModels {
  const chat = modelTarget('chat')
  const thinking = modelTarget('thinking')
  return { chat, thinking: thinking.configured ? thinking : chat, flash: flashTarget() }
}

/** The thinking model, or the chat model when none is configured (config-check warns at startup). */
export const getThinkingModelOrFallback = () => languageModel(localTurnModels().thinking)

export function getEmbeddingModel(): EmbeddingModel {
  const t = modelTarget('embed')
  return provider(t).textEmbeddingModel(t.model) as EmbeddingModel
}
