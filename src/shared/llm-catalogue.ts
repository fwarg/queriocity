/** Admin-managed catalogue of extra LLM providers — cloud services, or larger models on your own
 *  network — and the models users may pick from them per message. */

/** Which turn slots a model may fill: the answer (and flash), the thinking pass, or either. */
export type CloudModelRole = 'chat' | 'thinking' | 'both'

/** Catalogue ids: Queriocity's own names for providers and models, kept simple because usage and
 *  access rows refer to them. A provider's name for a model goes in `CloudModel.model`. */
export const CATALOGUE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Request fields a provider understands beyond the OpenAI ones, e.g. Cortecs routing options. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
/** Top-level fields with any JSON value, e.g. OpenRouter's nested `{ "provider": { "zdr": true } }`. */
export type ExtraBody = Record<string, JsonValue>

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
  extraBody?: ExtraBody
  /** What one unit of a cost the provider reports in its responses (`usage.cost`) is worth in
   *  `currency`: 1 for OpenRouter (credits = USD), 0.000001 for Cortecs (millionths of a euro).
   *  Unset: the provider's own figure is ignored and cost is estimated from the catalogue prices. */
  reportedCostUnit?: number
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
  /** Request fields for this model only, applied over the provider's: e.g. pinning Cortecs to the
   *  hosting provider whose price is entered above. */
  extraBody?: ExtraBody
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
  /** The context meter's whole for this model, in characters. */
  budgetChars: number
}

/** What the chat input needs to offer models and size the context meter for the next message. */
export interface ModelChoices {
  models: PickableModel[]
  /** The default models: flash's, the chat model, and the thinking model thorough may use. */
  defaults: { flash: DefaultModel; chat: DefaultModel; thinking: DefaultModel }
}

export interface DefaultModel {
  /** Its display name (`*_MODEL_LABEL`, else the model name), so the menu can say which model "default" is. */
  model: string
  /** The context meter's whole for it, in characters. */
  budgetChars: number
}

/** The model an answer came from, stored with the message. `default` is the env-configured model
 *  (its name in `id` and `label`); `cloud` and `local` are catalogue picks. */
export interface AnswerModel {
  id: string
  label: string
  kind: ProviderKind | 'default'
  /** The provider's label, so a reopened chat can say where a cloud answer was sent; absent for `default`. */
  provider?: string
  /** The hosting provider a routing service (Cortecs, OpenRouter) passed the request on to. */
  via?: string
  /** What the answer's calls cost, in `currency`; absent when nothing was metered (local models, a cached answer). */
  cost?: number
  currency?: string
  /** What the answer's calls used, local models included; absent for a cached answer. */
  tokens?: AnswerTokens
}

/** Token counts summed over an answer's calls of the answering model (helpers on the small model,
 *  such as the title or Auto's choice, are not counted). */
export interface AnswerTokens {
  input: number
  /** Includes `reasoning`. */
  output: number
  reasoning?: number
  calls: number
  /** A call was cut off before reporting, so its counts are an estimate. */
  estimated?: boolean
}


/** Why a model pick was not honoured; the client words the notice from this. */
export type ModelFallbackReason = 'locked' | 'mode' | 'unavailable' | 'not_allowed' | 'unacknowledged' | 'budget' | 'cap'

export const EMPTY_CATALOGUE: LlmCatalogue = { providers: [], models: [] }
