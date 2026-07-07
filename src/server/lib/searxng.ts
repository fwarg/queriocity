import { searchApi, isSearchApiEnabled } from './search-api.ts'

const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:4000'


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
  const res = await fetch(url.toString())
  if (!res.ok) {
    console.error(`  [searxng] error: ${res.status} for query "${query}"`)
    return []
  }
  const data = await res.json() as {
    results?: Array<{ title: string; url: string; content?: string }>
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
  const seen = new Set<string>()
  const deduped = mapped.filter(r => {
    try {
      const domain = new URL(r.url).hostname.replace(/^www\./, '')
      if (seen.has(domain)) return false
      seen.add(domain)
      return true
    } catch {
      return true
    }
  })
  const results = deduped.slice(0, count)
  const ms = (performance.now() - start).toFixed(0)
  console.log(`  [searxng] ${SEARXNG_URL} q="${query}" — ${ms}ms → ${results.length} results`)

  // Keyed-API fallback: only when SearXNG found nothing, and only while the per-request
  // budget allows. The check + decrement are synchronous (no await between) so parallel
  // queries in webSearchMulti cannot collectively exceed the cap.
  if (results.length === 0 && isSearchApiEnabled()) {
    if (!apiBudget || apiBudget.remaining <= 0) {
      console.log(`  [search-api] budget exhausted — skipping fallback for "${query}"`)
    } else {
      apiBudget.remaining--
      const left = apiBudget.remaining   // capture before await; parallel calls decrement concurrently
      const api = await searchApi(query, count)
      console.log(`  [search-api] fallback ${api.length ? 'used' : 'empty'}, ${left} left for this request`)
      if (api.length) return api
    }
  }
  return results
}
