import { timed } from './log.ts'

const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:4000'

export interface SearchResult {
  title: string
  url: string
  content: string
}

export async function webSearch(query: string, count = 10): Promise<SearchResult[]> {
  const url = new URL('/search', SEARXNG_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('engines', 'google,bing,duckduckgo')

  return timed('searxng', `${SEARXNG_URL} q="${query}"`, async () => {
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(`SearXNG error: ${res.status}`)
    const data = await res.json() as { results?: Array<{ title: string; url: string; content?: string }> }
    const results = (data.results ?? []).slice(0, count).map(r => ({
      title: r.title ?? '',
      url: r.url,
      content: r.content ?? '',
    }))
    console.log(`         → ${results.length} results`)
    return results
  })
}
