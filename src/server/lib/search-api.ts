import type { SearchResult } from './searxng.ts'

const PROVIDER = process.env.SEARCH_API_PROVIDER
const API_KEY = process.env.SEARCH_API_KEY

/** True only when a keyed search-API fallback is fully configured. */
export function isSearchApiEnabled(): boolean {
  return !!PROVIDER && !!API_KEY
}

/** Query a keyed search API as a fallback when SearXNG returns nothing. Returns [] on error/disabled. */
export async function searchApi(query: string, count: number): Promise<SearchResult[]> {
  if (!isSearchApiEnabled()) return []
  try {
    switch (PROVIDER) {
      case 'mojeek': return await mojeekSearch(query, count)
      default:
        console.warn(`  [search-api] unknown SEARCH_API_PROVIDER "${PROVIDER}"`)
        return []
    }
  } catch (e) {
    console.error(`  [search-api] ${PROVIDER} failed for "${query}":`, e)
    return []
  }
}

// Mojeek Search API — https://www.mojeek.com/support/api/search/
// GET https://www.mojeek.com/search?api_key=…&q=…&fmt=json&t=N
// → { response: { status: "OK", results: [{ url, title, desc, … }] } }
async function mojeekSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = new URL('https://www.mojeek.com/search')
  url.searchParams.set('api_key', API_KEY as string)
  url.searchParams.set('q', query)
  url.searchParams.set('fmt', 'json')
  url.searchParams.set('t', String(count))

  const start = performance.now()
  const res = await fetch(url.toString())
  if (!res.ok) {
    console.error(`  [search-api] mojeek HTTP ${res.status} for "${query}"`)
    return []
  }
  const data = await res.json() as {
    response?: { status?: string; results?: Array<{ url?: string; title?: string; desc?: string }> }
  }
  const r = data.response
  if (r?.status && r.status !== 'OK') {
    console.error(`  [search-api] mojeek status=${r.status} for "${query}"`)
    return []
  }
  const results: SearchResult[] = (r?.results ?? [])
    .filter(x => x.url)
    .map(x => ({ title: x.title ?? '', url: x.url as string, content: x.desc ?? '' }))
    .slice(0, count)
  const ms = (performance.now() - start).toFixed(0)
  console.log(`  [search-api] mojeek q="${query}" — ${ms}ms → ${results.length} results`)
  return results
}
