import { searchApi, isSearchApiEnabled } from './search-api.ts'

const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:4000'

// Top up via the keyed API when SearXNG returns fewer than this many results (not only when
// empty) — e.g. when the only surviving engine returns a thin trickle. Set to 1 for empty-only.
const API_MIN_RESULTS = parseInt(process.env.SEARCH_API_MIN_RESULTS ?? '3', 10)

// SearXNG aggregates many engines, so allow well over a single engine's latency — but never
// wait indefinitely: without this a wedged instance hangs the whole chat request.
const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS ?? '20000', 10)


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
  const url = new URL('/search', SEARXNG_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  if (process.env.SEARXNG_ENGINES) url.searchParams.set('engines', process.env.SEARXNG_ENGINES)
  if (categories) url.searchParams.set('categories', categories)
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
  const results = dedupeByDomain(mapped).slice(0, count)
  const ms = (performance.now() - start).toFixed(0)
  // Which engines actually contributed (SearXNG tags each result with its source engines).
  const engines = new Set<string>()
  for (const r of data.results ?? []) for (const e of r.engines ?? (r.engine ? [r.engine] : [])) engines.add(e)
  const from = engines.size ? ` from ${[...engines].sort().join(', ')}` : ''
  console.log(`  [searxng] ${SEARXNG_URL} q="${query}" — ${ms}ms → ${results.length} results${from}`)

  // Keyed-API top-up: when SearXNG returns too few results (blocked engines, or only a thin
  // trickle from a survivor like Marginalia), and while the per-request budget allows. The
  // check + decrement are synchronous (no await between) so parallel queries in webSearchMulti
  // cannot collectively exceed the cap.
  if (results.length < API_MIN_RESULTS && isSearchApiEnabled()) {
    if (!apiBudget || apiBudget.remaining <= 0) {
      console.log(`  [search-api] budget exhausted — skipping fallback for "${query}"`)
    } else {
      apiBudget.remaining--
      const left = apiBudget.remaining   // capture before await; parallel calls decrement concurrently
      const api = await searchApi(query, count)
      if (api.length) {
        const merged = dedupeByDomain([...results, ...api]).slice(0, count)
        console.log(`  [search-api] fallback used — searxng ${results.length} + mojeek ${api.length} → ${merged.length}, ${left} left`)
        return merged
      }
      console.log(`  [search-api] fallback empty, ${left} left for this request`)
    }
  }
  return results
}
