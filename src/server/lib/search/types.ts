export interface SearchResult {
  title: string
  url: string
  content: string
}

/** An engine SearXNG could not query (e.g. suspended after rate-limit/CAPTCHA/access-denied). */
export interface EngineError {
  engine: string
  reason: string
}

/** Mutable per-request/run allowance for calls to fallback (typically paid) providers. */
export interface SearchApiBudget {
  remaining: number
}

/** A hit as a provider returns it, before fusion strips the attribution. */
export interface ProviderResult extends SearchResult {
  /** Sub-engines that returned this hit, for a meta-engine; used for per-engine weights. */
  engines?: string[]
}

export interface ProviderOutcome {
  results: ProviderResult[]
  /** Sub-engines that contributed at least one hit (a meta-engine's attribution). */
  engines: Set<string>
  errors: EngineError[]
  /** The request itself failed — distinct from "answered with nothing", which can still be topped up. */
  failed: boolean
}

export interface SearchProvider {
  id: string
  label: string
  kind: 'meta' | 'api' | 'index'
  /** Hits are passages the provider chose for this query and it already caps hits per site, so
   *  its copy of a page wins over another provider's and domain dedup does not apply to it. */
  passageHits?: boolean
  /** Env vars this provider reads, shown to admins; secrets themselves never leave env. */
  envVars: string[]
  isConfigured(): boolean
  search(query: string, count: number, categories?: string): Promise<ProviderOutcome>
  /** The provider's stored copy of a page, or null; lets fetch_url skip a live page load. */
  fetchDocument?(url: string): Promise<string | null>
}

/** An outcome with nothing in it, for a provider skipped or failed before it could answer. */
export const emptyOutcome = (failed = false): ProviderOutcome =>
  ({ results: [], engines: new Set(), errors: [], failed })
