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
  url.searchParams.set('engines', 'google,bing,duckduckgo')

  const start = performance.now()
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`SearXNG error: ${res.status}`)
  const data = await res.json() as { results?: Array<{ title: string; url: string; content?: string }> }
  const results = (data.results ?? []).slice(0, count).map(r => ({
    title: r.title ?? '',
    url: r.url,
    content: r.content ?? '',
  }))
  const ms = (performance.now() - start).toFixed(0)
  console.log(`  [searxng] ${SEARXNG_URL} q="${query}" — ${ms}ms → ${results.length} results`)
  return results
}
