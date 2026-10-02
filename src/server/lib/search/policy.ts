/** How the search providers are combined: which run, in what role, and how much each is trusted.
 *
 *  Defaults come from the env vars that configured search before providers became plugins, so a
 *  deployment that never opens the admin panel behaves exactly as before. Once an admin saves, the
 *  stored policy (app_settings `search_policy`) overrides those defaults field by field. Read per
 *  call, so an edit takes effect without a restart. Secrets are deliberately not part of it: keys
 *  stay in env, under names fixed per provider, so the panel cannot point a provider at an
 *  arbitrary env var and send that value off-site. */

import { z } from 'zod'
import { getAppSetting, setAppSetting } from '../db.ts'

export const POLICY_SETTING = 'search_policy'

/** An engine weighted at least this much counts as "major" for the fallback rule. */
export const MAJOR_ENGINE_WEIGHT = 1

const weight = z.number().min(0).max(10)

export const providerPolicySchema = z.object({
  enabled: z.boolean(),
  /** primary: always runs, its results are the base. supplement: runs alongside, in slots of its
   *  own. fallback: runs only when the primaries came back thin, within the per-request budget. */
  role: z.enum(['primary', 'supplement', 'fallback']),
  weight,
  /** Results this provider is guaranteed in the merged list (spejaren's reserved slots). */
  minSlots: z.number().int().min(0).max(50),
  /** May serve web_search in a locked space — i.e. may see that space's queries. */
  trustedForLocked: z.boolean(),
  /** Calls allowed per UTC calendar month, attempted calls counted (APIs bill per request); 0 = unlimited. */
  monthlyQuota: z.number().int().min(0),
  /** Per sub-engine weights for a meta-engine; unlisted engines get `defaultEngineWeight`. */
  engineWeights: z.record(z.string(), weight),
  defaultEngineWeight: weight,
})

export const searchPolicySchema = z.object({
  /** legacy: the original rules (primaries, then top-up, then interleaved supplements).
   *  rrf: weighted Reciprocal Rank Fusion over every provider's ranking. */
  fusion: z.enum(['legacy', 'rrf']),
  rrfK: z.number().int().min(1).max(1000),
  /** Fallback-provider calls allowed per chat request or monitor run, shared by all fallbacks. */
  fallbackBudgetPerRequest: z.number().int().min(0).max(100),
  /** Call a fallback when the primaries return fewer results than this (1 = empty-only). */
  fallbackMinResults: z.number().int().min(0).max(50),
  /** Also call one when no major engine contributed, however many results came back. */
  fallbackWhenNoMajorEngine: z.boolean(),
  /** Search queries per chat request or monitor run, across every provider; 0 = unlimited. */
  maxQueriesPerRequest: z.number().int().min(0).max(1000),
  providers: z.record(z.string(), providerPolicySchema),
})

export type ProviderPolicy = z.infer<typeof providerPolicySchema>
export type SearchPolicy = z.infer<typeof searchPolicySchema>

/** What an admin may store: any subset, merged over the env defaults. */
export const storedPolicySchema = searchPolicySchema.partial().extend({
  providers: z.record(z.string(), providerPolicySchema.partial()).optional(),
})
type StoredPolicy = z.infer<typeof storedPolicySchema>

const intEnv = (name: string, fallback: number) => {
  const n = parseInt(process.env[name] ?? '', 10)
  return Number.isNaN(n) ? fallback : n
}

const PROVIDER_DEFAULTS: ProviderPolicy = {
  enabled: true, role: 'primary', weight: 1, minSlots: 0, trustedForLocked: false, monthlyQuota: 0,
  engineWeights: {}, defaultEngineWeight: 1,
}

/** The policy the pre-plugin env vars describe. */
export function envPolicy(): SearchPolicy {
  const majors = (process.env.SEARCH_MAJOR_ENGINES ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  return {
    fusion: 'legacy',
    rrfK: 60,
    fallbackBudgetPerRequest: intEnv('SEARCH_API_MAX_PER_REQUEST', 3),
    fallbackMinResults: intEnv('SEARCH_API_MIN_RESULTS', 3),
    fallbackWhenNoMajorEngine: true,
    maxQueriesPerRequest: 0,
    providers: {
      // Without a major-engine list every engine weighs 1, so none is "niche" and the
      // no-major-engine rule never fires — which is what an unset SEARCH_MAJOR_ENGINES meant.
      searxng: {
        ...PROVIDER_DEFAULTS,
        engineWeights: Object.fromEntries(majors.map(e => [e, MAJOR_ENGINE_WEIGHT])),
        defaultEngineWeight: majors.length ? 0.5 : 1,
      },
      spejaren: {
        ...PROVIDER_DEFAULTS, role: 'supplement', minSlots: intEnv('SPEJAREN_COUNT', 4),
        trustedForLocked: process.env.SPEJAREN_TRUSTED?.trim().toLowerCase() === 'true',
      },
      mojeek: { ...PROVIDER_DEFAULTS, role: 'fallback' },
    },
  }
}

/** Stored fields over env defaults, per provider; providers the store doesn't mention keep theirs. */
export function mergePolicy(base: SearchPolicy, stored: StoredPolicy): SearchPolicy {
  const providers = { ...base.providers }
  for (const [id, p] of Object.entries(stored.providers ?? {})) {
    providers[id] = { ...(providers[id] ?? PROVIDER_DEFAULTS), ...p }
  }
  return { ...base, ...stored, providers }
}

/** The effective policy: the stored one over env defaults, or env alone when none is stored or it is unreadable. */
export async function loadSearchPolicy(): Promise<SearchPolicy> {
  const base = envPolicy()
  const raw = await getAppSetting(POLICY_SETTING, '')
  if (!raw) return base
  let json: unknown
  try { json = JSON.parse(raw) } catch { json = null }
  const parsed = storedPolicySchema.safeParse(json)
  if (!parsed.success) {
    console.warn(`  [search] stored ${POLICY_SETTING} is invalid — using env defaults`)
    return base
  }
  return mergePolicy(base, parsed.data)
}

export async function saveSearchPolicy(policy: SearchPolicy): Promise<void> {
  await setAppSetting(POLICY_SETTING, JSON.stringify(policy))
}

/** True when an admin has saved a policy, i.e. env defaults are overridden. */
export async function hasStoredSearchPolicy(): Promise<boolean> {
  return (await getAppSetting(POLICY_SETTING, '')) !== ''
}

/** Back to env defaults: an empty value reads as "none stored". */
export async function resetSearchPolicy(): Promise<void> {
  await setAppSetting(POLICY_SETTING, '')
}

/** A sub-engine's weight. SearXNG names variants after their parent — "brave.news", "bing news",
 *  "google scholar" — so the first token matches too, or those would all read as niche engines. */
export function engineWeight(p: ProviderPolicy, engine: string): number {
  const name = engine.trim().toLowerCase()
  return p.engineWeights[name] ?? p.engineWeights[name.split(/[\s.]/)[0]] ?? p.defaultEngineWeight
}

const envSearxng = () => envPolicy().providers.searxng

export function isMajorEngine(engine: string, p: ProviderPolicy = envSearxng()): boolean {
  return engineWeight(p, engine) >= MAJOR_ENGINE_WEIGHT
}

/** True when some engines are major and others not; otherwise the no-major-engine rule is inactive. */
export function hasMajorEngineList(p: ProviderPolicy = envSearxng()): boolean {
  return p.defaultEngineWeight < MAJOR_ENGINE_WEIGHT && Object.values(p.engineWeights).some(w => w >= MAJOR_ENGINE_WEIGHT)
}
