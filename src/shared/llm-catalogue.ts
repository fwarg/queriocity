/** Admin-managed catalogue of cloud LLM providers and the models users may pick from them. */

/** Which turn slots a model may fill: the answer (and flash), the thinking pass, or either. */
export type CloudModelRole = 'chat' | 'thinking' | 'both'

export interface CloudProvider {
  /** Stable id; usage and access rows refer to it, so it never changes once saved. */
  id: string
  label: string
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1. */
  baseURL: string
  /** Name of the env var that holds the key; the key itself is never stored. Must end in _API_KEY. */
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

export const EMPTY_CATALOGUE: LlmCatalogue = { providers: [], models: [] }
