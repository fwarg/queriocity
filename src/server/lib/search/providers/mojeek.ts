import { emptyOutcome, type ProviderOutcome, type SearchProvider } from '../types.ts'
import { SEARCH_TIMEOUT_MS } from '../timeout.ts'

// Keyed by the generic SEARCH_API_PROVIDER/SEARCH_API_KEY pair it was configured with before
// providers became plugins, so existing deployments keep working. Read per call.
const apiKey = () => process.env.SEARCH_API_PROVIDER === 'mojeek' ? process.env.SEARCH_API_KEY : undefined

// Mojeek Search API — https://www.mojeek.com/support/api/search/
// GET https://www.mojeek.com/search?api_key=…&q=…&fmt=json&t=N
// → { response: { status: "OK", results: [{ url, title, desc, … }] } }
async function search(query: string, count: number): Promise<ProviderOutcome> {
  const url = new URL('https://www.mojeek.com/search')
  url.searchParams.set('api_key', apiKey() ?? '')
  url.searchParams.set('q', query)
  url.searchParams.set('fmt', 'json')
  url.searchParams.set('t', String(count))

  const start = performance.now()
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS()) })
    if (!res.ok) {
      console.error(`  [mojeek] HTTP ${res.status} for "${query}"`)
      return emptyOutcome(true)
    }
    const data = await res.json() as {
      response?: { status?: string; results?: Array<{ url?: string; title?: string; desc?: string }> }
    }
    const r = data.response
    if (r?.status && r.status !== 'OK') {
      console.error(`  [mojeek] status=${r.status} for "${query}"`)
      return emptyOutcome(true)
    }
    const results = (r?.results ?? [])
      .filter(x => x.url)
      .map(x => ({ title: x.title ?? '', url: x.url as string, content: x.desc ?? '' }))
      .slice(0, count)
    console.log(`  [mojeek] q="${query}" — ${(performance.now() - start).toFixed(0)}ms → ${results.length} results`)
    return { results, engines: new Set(), errors: [], failed: false }
  } catch (e) {
    console.error(`  [mojeek] failed for "${query}": ${e instanceof Error ? e.message : e}`)
    return emptyOutcome(true)
  }
}

export const mojeekProvider: SearchProvider = {
  id: 'mojeek',
  label: 'Mojeek API',
  kind: 'api',
  envVars: ['SEARCH_API_PROVIDER=mojeek', 'SEARCH_API_KEY'],
  isConfigured: () => !!apiKey(),
  search,
}
