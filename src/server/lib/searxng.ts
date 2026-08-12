import { searchApi, isSearchApiEnabled, searchApiProvider } from './search-api.ts'

// Read per call, not at module load: a module-level const captures whatever was set when the
// first importer pulled this in, which makes the value depend on import order (it silently
// broke a test whose stub server started later). Same reasoning as getMajorEngines below.
const searxngUrl = () => process.env.SEARXNG_URL ?? 'http://localhost:4000'

// Top up via the keyed API when SearXNG returns fewer than this many results (not only when
// empty) — e.g. when the only surviving engine returns a thin trickle. Set to 1 for empty-only.
const API_MIN_RESULTS = parseInt(process.env.SEARCH_API_MIN_RESULTS ?? '3', 10)

// Engines broad enough that results from them alone are worth trusting. Deliberately empty by
// default: which engines a SearXNG instance runs is a deployment decision, and a list baked
// into the code would mis-classify anyone whose set differs. Unset simply means the
// "no major engine responded" top-up below never fires.
// Read on first use rather than at module load: reading at load makes the value depend on
// import order. Memoised against the raw string rather than "first call wins", because that
// still depended on order — whichever caller searched first froze the value, so a test that set
// the variable and then imported this module saw the empty set another test had already cached.
let majorEngines: { raw: string; set: Set<string> } | null = null
function getMajorEngines(): Set<string> {
  const raw = process.env.SEARCH_MAJOR_ENGINES ?? ''
  if (majorEngines?.raw !== raw) {
    majorEngines = { raw, set: new Set(raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)) }
  }
  return majorEngines.set
}

/** True when a major-engine list is configured at all; without one that rule is inactive. */
export function hasMajorEngineList(): boolean {
  return getMajorEngines().size > 0
}

/** SearXNG names variants after their parent — "brave.news", "bing news", "startpage news",
 *  "google scholar" — so match on the first token too, or those all read as niche engines and
 *  trigger a paid top-up that isn't needed. */
export function isMajorEngine(engine: string): boolean {
  const engines = getMajorEngines()
  const name = engine.trim().toLowerCase()
  return engines.has(name) || engines.has(name.split(/[\s.]/)[0])
}

// SearXNG aggregates many engines, so allow well over a single engine's latency — but never
// wait indefinitely: without this a wedged instance hangs the whole chat request.
const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS ?? '20000', 10)

// Categories queried when the caller names none. SearXNG otherwise falls back to `general`
// alone, so engines registered under another category (news, science…) are never reached at
// all — a working news engine can sit unused while general engines return nothing useful.
// Applied here rather than at the route so every caller benefits, agentic searches included.
const DEFAULT_CATEGORIES = process.env.SEARCH_DEFAULT_CATEGORIES?.trim() || undefined


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

/** Mutable per-request/run allowance for paid keyed-API fallback calls. */
export interface SearchApiBudget {
  remaining: number
}

/** A `site:`-scoped query deliberately asks for one domain, so per-domain dedup would discard
 *  everything but the first hit — turning 8 articles from the requested site into 1. */
export function isSiteScoped(query: string): boolean {
  return /\bsite:\S/i.test(query)
}

/** Drop results sharing a hostname (ignoring leading www.), keeping the first occurrence. */
function dedupeByDomain(list: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return list.filter(r => {
    try {
      const domain = new URL(r.url).hostname.replace(/^www\./, '')
      if (seen.has(domain)) return false
      seen.add(domain)
      return true
    } catch {
      return true
    }
  })
}

export async function webSearchMulti(
  queries: string[],
  countEach: number,
  categories?: string,
  onEngineErrors?: (errors: EngineError[]) => void,
  apiBudget?: SearchApiBudget,
): Promise<SearchResult[]> {
  const batches = await Promise.all(queries.map(q => webSearch(q, countEach, categories, onEngineErrors, apiBudget)))
  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const batch of batches) {
    for (const r of batch) {
      if (!seen.has(r.url)) {
        seen.add(r.url)
        results.push(r)
      }
    }
  }
  return results
}

export async function webSearch(
  query: string,
  count = 10,
  categories?: string,
  onEngineErrors?: (errors: EngineError[]) => void,
  apiBudget?: SearchApiBudget,
): Promise<SearchResult[]> {
  const base = searxngUrl()
  const url = new URL('/search', base)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  if (process.env.SEARXNG_ENGINES) url.searchParams.set('engines', process.env.SEARXNG_ENGINES)
  const effectiveCategories = categories ?? DEFAULT_CATEGORIES
  if (effectiveCategories) url.searchParams.set('categories', effectiveCategories)
  url.searchParams.set('language', 'all')

  const start = performance.now()
  let res: Response
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) })
  } catch (e) {
    console.error(`  [searxng] request failed for "${query}": ${e instanceof Error ? e.message : e}`)
    return []
  }
  if (!res.ok) {
    console.error(`  [searxng] error: ${res.status} for query "${query}"`)
    return []
  }
  const data = await res.json() as {
    results?: Array<{ title: string; url: string; content?: string; engine?: string; engines?: string[] }>
    unresponsive_engines?: Array<[string, string]>
  }
  // unresponsive_engines is [engine, reason] tuples, e.g. ["brave", "Suspended: too many requests"]
  const engineErrors: EngineError[] = (data.unresponsive_engines ?? []).map(([engine, reason]) => ({ engine, reason }))
  if (engineErrors.length) {
    console.warn(`  [searxng] unresponsive engines for "${query}": ${engineErrors.map(e => `${e.engine} (${e.reason})`).join(', ')}`)
    onEngineErrors?.(engineErrors)
  }
  const mapped = (data.results ?? []).map(r => ({
    title: r.title ?? '',
    url: r.url,
    content: r.content ?? '',
  }))
  const siteScoped = isSiteScoped(query)
  const results = (siteScoped ? mapped : dedupeByDomain(mapped)).slice(0, count)
  const ms = (performance.now() - start).toFixed(0)
  // Which engines actually contributed (SearXNG tags each result with its source engines).
  const engines = new Set<string>()
  for (const r of data.results ?? []) for (const e of r.engines ?? (r.engine ? [r.engine] : [])) engines.add(e)
  const from = engines.size ? ` from ${[...engines].sort().join(', ')}` : ''
  console.log(`  [searxng] ${base} q="${query}" — ${ms}ms → ${results.length} results${from}`)

  // Keyed-API top-up, on either of two conditions, while the per-request budget allows:
  //  - too few results at all (blocked engines, or a thin trickle);
  //  - no major engine contributed, however many results came back. A healthy-looking count
  //    from a niche index alone (e.g. Marginalia, which doesn't carry news) is worse than it
  //    looks: the model gets plenty to read and none of it answers the question.
  // The check + decrement are synchronous (no await between) so parallel queries in
  // webSearchMulti cannot collectively exceed the cap.
  // The second rule needs both a configured list and known attribution — without either it
  // would fire on every search, so it stays off rather than guessing.
  const noMajorEngine = hasMajorEngineList() && engines.size > 0 && ![...engines].some(isMajorEngine)
  const topUpReason = results.length < API_MIN_RESULTS
    ? `only ${results.length} result(s)`
    : noMajorEngine
      ? `no major engine responded (got ${[...engines].sort().join(', ')})`
      : null

  if (topUpReason && isSearchApiEnabled()) {
    if (!apiBudget || apiBudget.remaining <= 0) {
      console.log(`  [search-api] budget exhausted — skipping fallback for "${query}"`)
    } else {
      console.log(`  [search-api] topping up "${query}": ${topUpReason}`)
      apiBudget.remaining--
      const left = apiBudget.remaining   // capture before await; parallel calls decrement concurrently
      const api = await searchApi(query, count)
      if (api.length) {
        // Order matters: the merge is truncated to `count`. When SearXNG already returned a
        // full page from niche engines, appending the API results would slice them all away
        // again — so in that case the paid results go first, which is the point of the call.
        const apiFirst = noMajorEngine && results.length >= count
        const combined = apiFirst ? [...api, ...results] : [...results, ...api]
        const merged = (siteScoped ? combined : dedupeByDomain(combined)).slice(0, count)
        console.log(`  [search-api] fallback used — searxng ${results.length} + ${searchApiProvider()} ${api.length} → ${merged.length}${apiFirst ? ' (api first)' : ''}, ${left} left`)
        return merged
      }
      console.log(`  [search-api] fallback empty, ${left} left for this request`)
    }
  }
  return results
}
