/** Admin-managed catalogue of extra LLM providers — cloud services, or larger models on your own
 *  network — and the models users may pick from them per message. */

/** Which turn slots a model may fill: the answer (and flash), the thinking pass, or either. */
export type CloudModelRole = 'chat' | 'thinking' | 'both'

/** Cloud providers are metered against budgets; local ones run on your own hardware and are not. */
export type ProviderKind = 'cloud' | 'local'

export interface CloudProvider {
  /** Stable id; usage and access rows refer to it, so it never changes once saved. */
  id: string
  label: string
  kind: ProviderKind
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1. */
  baseURL: string
  /** Name of the env var that holds the key; the key itself is never stored. Must end in _API_KEY.
   *  Optional for a local provider, which often needs none. */
  apiKeyEnv: string
  /** ISO 4217 code; prices, budgets and the cap of this provider are in it. */
  currency: string
  /** Global spend cap per calendar month across all users; 0 = no cap. */
  monthlyCap: number
  /** Provider-specific request fields added to every call, e.g. Cortecs `{ "eu_native": true }`. */
  extraBody?: Record<string, string | number | boolean>
  enabled: boolean
}

export interface CloudModel {
  id: string
  providerId: string
  /** The model name the provider expects, e.g. anthropic/claude-sonnet-4. */
  model: string
  label: string
  role: CloudModelRole
  contextTokens: number
  /** Output cap per call; reasoning tokens count against it on most providers. */
  maxOutputTokens: number
  /** Price per million input / output tokens, in the provider's currency. */
  priceIn: number
  priceOut: number
  enabled: boolean
}

export interface LlmCatalogue {
  providers: CloudProvider[]
  models: CloudModel[]
}

/** What an admin granted one user: the cloud switch, and a monthly budget per provider they may use. */
export interface LlmAccess {
  cloudEnabled: boolean
  /** Provider id → budget in that provider's currency. A provider absent here is not allowed. */
  budgets: Record<string, number>
}

/** One user's spend with one provider in one month. */
export interface UsageRow {
  userId: string
  providerId: string
  cost: number
  inputTokens: number
  outputTokens: number
  requests: number
}

/** A model the current user may pick, as the chat input lists it. */
export interface PickableModel {
  id: string
  label: string
  role: CloudModelRole
  providerId: string
  providerLabel: string
  kind: ProviderKind
  /** Budget left this month in `currency`; absent for a local provider, which has none. */
  remaining?: number
  currency?: string
  /** Whether a locked space may use it: only a local provider whose endpoint is on this network. */
  allowedWhenLocked: boolean
}

/** The picked model an answer came from, stored with the message; absent for the default model. */
export interface AnswerModel {
  id: string
  label: string
  kind: ProviderKind
  /** The provider's label, so a reopened chat can say where a cloud answer was sent. */
  provider: string
}

/** Why a model pick was not honoured; the client words the notice from this. */
export type ModelFallbackReason = 'locked' | 'mode' | 'unavailable' | 'not_allowed' | 'unacknowledged' | 'budget' | 'cap'

export const EMPTY_CATALOGUE: LlmCatalogue = { providers: [], models: [] }
