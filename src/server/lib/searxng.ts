const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:4000'


export interface SearchResult {
  title: string
  url: string
  content: string
}

export async function webSearchMulti(queries: string[], countEach: number): Promise<SearchResult[]> {
  const batches = await Promise.all(queries.map(q => webSearch(q, countEach)))
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

export async function webSearch(query: string, count = 10): Promise<SearchResult[]> {
  const url = new URL('/search', SEARXNG_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  if (process.env.SEARXNG_ENGINES) url.searchParams.set('engines', process.env.SEARXNG_ENGINES)
  url.searchParams.set('language', 'all')

  const start = performance.now()
  const res = await fetch(url.toString())
  if (!res.ok) {
    console.error(`  [searxng] error: ${res.status} for query "${query}"`)
    return []
  }
  const data = await res.json() as { results?: Array<{ title: string; url: string; content?: string }> }
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
  return results
}
