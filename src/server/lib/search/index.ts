/** Web search across the registered providers, combined per the search policy.
 *
 *  Adding a provider: implement SearchProvider in providers/, list it in PROVIDERS, and give it a
 *  default in policy.ts envPolicy(). Nothing outside this directory needs to change. */

import { interleaveSupplements, mergeBatches, mergeFallback, mergePrimaries, pageKey, plain, rrfFuse, type ProviderRun } from './fusion.ts'
import { hasMajorEngineList, isMajorEngine, loadSearchPolicy, type ProviderPolicy, type SearchPolicy } from './policy.ts'
import { mojeekProvider } from './providers/mojeek.ts'
import { searxngProvider } from './providers/searxng.ts'
import { spejarenProvider } from './providers/spejaren.ts'
import { recordCall, recordKept } from './telemetry.ts'
import type { EngineError, ProviderOutcome, SearchApiBudget, SearchProvider, SearchResult } from './types.ts'
import { emptyOutcome } from './types.ts'

export type { SearchResult, EngineError, SearchApiBudget } from './types.ts'
export { isSiteScoped } from './fusion.ts'

/** Every provider, in priority order: an earlier primary's results come first in the legacy merge. */
export const PROVIDERS: SearchProvider[] = [searxngProvider, spejarenProvider, mojeekProvider]

type Role = ProviderPolicy['role']
interface Active { provider: SearchProvider; policy: ProviderPolicy }
type Run = ProviderRun & { outcome: ProviderOutcome }

/** Providers that are enabled by policy and configured by env, optionally of one role. */
function activeProviders(policy: SearchPolicy, role?: Role): Active[] {
  return PROVIDERS
    .map(provider => ({ provider, policy: policy.providers[provider.id] }))
    .filter(a => a.policy?.enabled && a.provider.isConfigured() && (!role || a.policy.role === role))
}

async function runProvider(a: Active, query: string, count: number, categories?: string): Promise<Run> {
  if (count <= 0) return { ...a, results: [], outcome: emptyOutcome() }
  const start = performance.now()
  const outcome = await a.provider.search(query, count, categories)
  recordCall(a.provider.id, performance.now() - start, outcome.failed, outcome.results)
  return { ...a, results: outcome.results, outcome }
}

/** Hits a supplement adds to a search asking for `count`: its reserved slots, capped at `count`. */
const supplementCount = (p: ProviderPolicy, count: number) => Math.min(count, p.minSlots)

/** The engines that answered, when every one of them is niche; null when a major one contributed
 *  or the rule can't apply. It needs both a major-engine list and known attribution — without
 *  either it would fire on every search, so it stays off rather than guessing. A primary that is
 *  not a meta-engine counts as major whenever it returned anything. */
function nicheOnlyEngines(runs: Run[], policy: SearchPolicy): string[] | null {
  if (!policy.fallbackWhenNoMajorEngine || !runs.some(r => hasMajorEngineList(r.policy))) return null
  const contributors = runs.flatMap(r => r.provider.kind === 'meta'
    ? [...r.outcome.engines].map(e => ({ name: e, major: isMajorEngine(e, r.policy) }))
    : r.results.length ? [{ name: r.provider.id, major: true }] : [])
  if (!contributors.length || contributors.some(c => c.major)) return null
  return contributors.map(c => c.name).sort()
}

/** Call fallback providers in order until one returns results, on either of two conditions, while
 *  the per-request budget allows:
 *   - too few results at all (blocked engines, or a thin trickle);
 *   - no major engine contributed, however many results came back. A healthy-looking count from a
 *     niche index alone is worse than it looks: plenty to read and none of it answers the question. */
async function runFallback(
  query: string, count: number, base: SearchResult[], primaries: Run[], policy: SearchPolicy, budget?: SearchApiBudget,
): Promise<{ run: Run; first: boolean } | null> {
  const fallbacks = activeProviders(policy, 'fallback')
  if (!fallbacks.length) return null
  const niche = nicheOnlyEngines(primaries, policy)
  const reason = base.length < policy.fallbackMinResults
    ? `only ${base.length} result(s)`
    : niche ? `no major engine responded (got ${niche.join(', ')})` : null
  if (!reason) return null
  for (const a of fallbacks) {
    // Check + decrement are synchronous (no await between), so parallel queries in
    // webSearchMulti cannot collectively exceed the cap.
    if (!budget || budget.remaining <= 0) {
      console.log(`  [search] fallback budget exhausted — skipping ${a.provider.id} for "${query}"`)
      return null
    }
    console.log(`  [search] ${a.provider.id} topping up "${query}": ${reason}`)
    budget.remaining--
    const left = budget.remaining   // captured before await; parallel calls decrement concurrently
    const run = await runProvider(a, query, count)
    const first = !!niche && base.length >= count
    if (run.results.length) {
      console.log(`  [search] fallback used — primaries ${base.length} + ${a.provider.id} ${run.results.length}${first ? ' (fallback first)' : ''}, ${left} left`)
      return { run, first }
    }
    console.log(`  [search] ${a.provider.id} fallback empty, ${left} left for this request`)
  }
  return null
}

export async function webSearch(
  query: string,
  count = 10,
  categories?: string,
  onEngineErrors?: (errors: EngineError[]) => void,
  apiBudget?: SearchApiBudget,
): Promise<SearchResult[]> {
  const policy = await loadSearchPolicy()
  // In parallel, so supplements add no latency beyond the primaries' own; each yields nothing on failure.
  const [primaries, supplements] = await Promise.all([
    Promise.all(activeProviders(policy, 'primary').map(a => runProvider(a, query, count, categories))),
    Promise.all(activeProviders(policy, 'supplement').map(a => runProvider(a, query, supplementCount(a.policy, count), categories))),
  ])
  const errors = [...primaries, ...supplements].flatMap(r => r.outcome.errors)
  if (errors.length) onEngineErrors?.(errors)

  const base = mergePrimaries(query, count, primaries)
  // The fallback judges the primaries alone: a supplement is a niche index, and a healthy count
  // from it must not hide that the broad engines failed. A failed request rules a top-up out.
  const fallback = primaries.some(r => !r.outcome.failed)
    ? await runFallback(query, count, base, primaries, policy, apiBudget)
    : null

  const fused = policy.fusion === 'rrf'
    ? rrfFuse(
        query,
        count + supplements.reduce((n, r) => n + supplementCount(r.policy, count), 0),
        [...primaries, ...supplements, ...(fallback ? [fallback.run] : [])],
        policy.rrfK,
      )
    : interleaveSupplements(
        fallback ? mergeFallback(query, count, base, fallback.run.results.map(plain), fallback.first) : base,
        supplements.map(r => r.results.map(plain)),
      )
  const kept = new Set(fused.map(r => pageKey(r.url)))
  for (const r of [...primaries, ...supplements, ...(fallback ? [fallback.run] : [])]) {
    recordKept(r.provider.id, r.results.filter(x => kept.has(pageKey(x.url))).length)
  }
  return fused
}

export async function webSearchMulti(
  queries: string[],
  countEach: number,
  categories?: string,
  onEngineErrors?: (errors: EngineError[]) => void,
  apiBudget?: SearchApiBudget,
): Promise<SearchResult[]> {
  return mergeBatches(await Promise.all(queries.map(q => webSearch(q, countEach, categories, onEngineErrors, apiBudget))))
}

/** The providers trusted for locked spaces, alone, over several queries — the only search a locked
 *  space may run. Deliberately no fallback to the untrusted ones. */
export async function trustedSearchMulti(queries: string[], countEach: number, categories?: string): Promise<SearchResult[]> {
  const trusted = activeProviders(await loadSearchPolicy()).filter(a => a.policy.trustedForLocked)
  const runs = await Promise.all(queries.flatMap(q => trusted.map(a => runProvider(a, q, countEach, categories))))
  return mergeBatches(runs.map(r => r.results.map(plain)))
}

/** True when some active provider may serve web_search in a locked space. */
export async function hasTrustedSearch(): Promise<boolean> {
  return activeProviders(await loadSearchPolicy()).some(a => a.policy.trustedForLocked)
}

/** True when some fallback provider could still rescue a search the primaries left empty. */
export async function hasFallbackSearch(): Promise<boolean> {
  return activeProviders(await loadSearchPolicy(), 'fallback').length > 0
}

/** A fresh per-request (or per-monitor-run) allowance for fallback calls. */
export async function newSearchBudget(): Promise<SearchApiBudget> {
  return { remaining: (await loadSearchPolicy()).fallbackBudgetPerRequest }
}

/** A provider's stored copy of a page (already extracted, no page load), or null. */
export async function fetchIndexedDocument(url: string): Promise<{ provider: string; text: string } | null> {
  for (const { provider } of activeProviders(await loadSearchPolicy())) {
    const text = await provider.fetchDocument?.(url)
    if (text) return { provider: provider.id, text }
  }
  return null
}

/** Static facts about every registered provider, for the admin panel. */
export function describeProviders() {
  return PROVIDERS.map(p => ({
    id: p.id, label: p.label, kind: p.kind, passageHits: !!p.passageHits,
    envVars: p.envVars, configured: p.isConfigured(),
  }))
}
