import { emptyOutcome, type EngineError, type ProviderOutcome, type ProviderResult, type SearchProvider } from '../types.ts'
import { SEARCH_TIMEOUT_MS } from '../timeout.ts'

// Read per call, not at module load: a module-level const captures whatever was set when the
// first importer pulled this in, which makes the value depend on import order (it silently
// broke a test whose stub server started later).
const searxngUrl = () => process.env.SEARXNG_URL ?? 'http://localhost:4000'

// Categories queried when the caller names none. SearXNG otherwise falls back to `general`
// alone, so engines registered under another category (news, science…) are never reached at
// all — a working news engine can sit unused while general engines return nothing useful.
// Applied here rather than at the route so every caller benefits, agentic searches included.
const defaultCategories = () => process.env.SEARCH_DEFAULT_CATEGORIES?.trim() || undefined

interface Infobox {
  infobox?: string
  id?: string
  content?: string
  urls?: Array<{ url?: string }>
  engine?: string
  engines?: string[]
}

/** Infoboxes as results. SearXNG's wikipedia engine emits *only* an infobox by default
 *  (`display_type: ["infobox"]`), so without this Wikipedia never reached the model. An infobox
 *  appears only when the query names its entity, and carries the article extract rather than a
 *  one-line description — so it goes first, and wins dedup against the same page's list result. */
export function infoboxResults(boxes: Infobox[]): ProviderResult[] {
  return boxes.flatMap(b => {
    const url = b.id?.startsWith('http') ? b.id : b.urls?.find(u => u.url)?.url
    if (!url || !b.content?.trim()) return []
    return [{ title: b.infobox ?? '', url, content: b.content, engines: b.engines ?? (b.engine ? [b.engine] : []) }]
  })
}

/** Query SearXNG. Results come back unsliced and undeduplicated; fusion does both. */
async function search(query: string, _count: number, categories?: string): Promise<ProviderOutcome> {
  const base = searxngUrl()
  const url = new URL('/search', base)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  if (process.env.SEARXNG_ENGINES) url.searchParams.set('engines', process.env.SEARXNG_ENGINES)
  const effectiveCategories = categories ?? defaultCategories()
  if (effectiveCategories) url.searchParams.set('categories', effectiveCategories)
  url.searchParams.set('language', 'all')

  const start = performance.now()
  let res: Response
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS()) })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error(`  [searxng] request failed for "${query}": ${reason}`)
    return emptyOutcome(true, reason)
  }
  if (!res.ok) {
    console.error(`  [searxng] error: ${res.status} for query "${query}"`)
    return emptyOutcome(true, `HTTP ${res.status}`)
  }
  const data = await res.json() as {
    results?: Array<{ title: string; url: string; content?: string; engine?: string; engines?: string[] }>
    unresponsive_engines?: Array<[string, string]>
    infoboxes?: Infobox[]
  }
  // unresponsive_engines is [engine, reason] tuples, e.g. ["brave", "Suspended: too many requests"]
  const errors: EngineError[] = (data.unresponsive_engines ?? []).map(([engine, reason]) => ({ engine, reason }))
  if (errors.length) {
    console.warn(`  [searxng] unresponsive engines for "${query}": ${errors.map(e => `${e.engine} (${e.reason})`).join(', ')}`)
  }
  const results = [...infoboxResults(data.infoboxes ?? []), ...(data.results ?? []).map(r => ({
    title: r.title ?? '',
    url: r.url,
    content: r.content ?? '',
    engines: r.engines ?? (r.engine ? [r.engine] : []),
  }))]
  // Which engines actually contributed (SearXNG tags each result with its source engines).
  const engines = new Set(results.flatMap(r => r.engines ?? []))
  const ms = (performance.now() - start).toFixed(0)
  const from = engines.size ? ` from ${[...engines].sort().join(', ')}` : ''
  console.log(`  [searxng] ${base} q="${query}" — ${ms}ms → ${results.length} results${from}`)
  return { results, engines, errors, failed: false }
}

export const searxngProvider: SearchProvider = {
  id: 'searxng',
  label: 'SearXNG',
  kind: 'meta',
  envVars: ['SEARXNG_URL', 'SEARXNG_ENGINES', 'SEARCH_DEFAULT_CATEGORIES'],
  // Always considered configured: SEARXNG_URL has a default, as it always has.
  isConfigured: () => true,
  search,
}
