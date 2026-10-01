/** Client for spejaren, a self-hosted small-web search index, queried alongside SearXNG.
 *
 *  Entirely optional: with SPEJAREN_URL unset every function here is a no-op, so queriocity runs
 *  exactly as without it. Env is read per call rather than at module load, for the import-order
 *  reason documented at the top of searxng.ts. */

import type { SearchResult } from './searxng.ts'

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_COUNT = 4
// Request limits enforced by the spejaren API; longer values get a 422 instead of results.
const MAX_QUERY_CHARS = 500
const MAX_URL_CHARS = 2048
const MAX_COUNT = 50

// SearXNG category names, as the UI chips arrive after toSearxngCategories, to spejaren filters.
const FILTER_BY_CATEGORY: Record<string, string> = { 'social media': 'forums', it: 'docs' }

interface SpejarenHit {
  title?: string
  url?: string
  content?: string
  publishedDate?: string | null
  lang?: string | null
  domain?: string | null
}

interface SpejarenDocument {
  title?: string | null
  lang?: string | null
  publishedDate?: string | null
  fetched_at?: string | null
  text?: string
  site?: { domain?: string | null } | null
}

const baseUrl = () => process.env.SPEJAREN_URL?.trim() || undefined
const timeoutMs = () => parseInt(process.env.SPEJAREN_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS

/** True when a spejaren instance is configured. */
export function isSpejarenEnabled(): boolean {
  return !!baseUrl()
}

/** True when spejaren may be searched from a locked space: configured *and* explicitly trusted. */
export function isSpejarenTrusted(): boolean {
  return isSpejarenEnabled() && process.env.SPEJAREN_TRUSTED?.trim().toLowerCase() === 'true'
}

/** Hits spejaren adds to a web search asking for `count`: SPEJAREN_COUNT, capped at `count`. */
export function spejarenCount(count: number): number {
  const configured = parseInt(process.env.SPEJAREN_COUNT ?? '', 10)
  return Math.min(count, Number.isNaN(configured) ? DEFAULT_COUNT : configured, MAX_COUNT)
}

/** The spejaren filter for a SearXNG category list: '' searches unfiltered, null skips spejaren.
 *  Null for categories it has no index for (news, science) — returning off-topic small-web pages
 *  would override the restriction the user picked. */
export function spejarenFilter(categories?: string): string | null {
  const cats = (categories ?? '').split(',').map(c => c.trim().toLowerCase()).filter(Boolean)
  if (!cats.length || cats.includes('general')) return ''
  // The API takes a single filter, so with several chips selected the first mappable one wins.
  return cats.map(c => FILTER_BY_CATEGORY[c]).find(Boolean) ?? null
}

/** One hit as a SearchResult. Site, language and date ride in a content prefix, as in rss.ts, so
 *  the model and the reranker see them without a change to the SearchResult type. */
export function toSearchResult(hit: SpejarenHit & { url: string }): SearchResult {
  const meta = ['spejaren', hit.domain, hit.lang, hit.publishedDate?.slice(0, 10)].filter(Boolean)
  return { title: hit.title ?? '', url: hit.url, content: `[${meta.join(' · ')}]\n${hit.content ?? ''}` }
}

/** Search spejaren; [] when unconfigured, skipped for the categories, or on any failure. */
export async function spejarenSearch(query: string, count: number, categories?: string): Promise<SearchResult[]> {
  const filter = spejarenFilter(categories)
  if (!isSpejarenEnabled() || filter === null || count <= 0) return []
  const params: Record<string, string> = { q: query.slice(0, MAX_QUERY_CHARS), count: String(Math.min(count, MAX_COUNT)) }
  if (filter) params.filter = filter

  const start = performance.now()
  const data = await apiGet<{ results?: SpejarenHit[]; ranking?: string }>('api/v1/search', params)
  if (!data) return []
  const results = (data.results ?? [])
    .filter((h): h is SpejarenHit & { url: string } => !!h.url)
    .map(toSearchResult)
  const ms = (performance.now() - start).toFixed(0)
  console.log(`  [spejaren] q="${query}"${filter ? ` filter=${filter}` : ''} — ${ms}ms → ${results.length} results (${data.ranking ?? 'unknown'})`)
  return results
}

/** A page's text as spejaren indexed it, or null when unconfigured, not indexed, or unreachable.
 *  The copy is from spejaren's last crawl, so the header states when it was fetched. */
export async function spejarenDocument(url: string): Promise<string | null> {
  if (!isSpejarenEnabled() || url.length > MAX_URL_CHARS) return null
  const doc = await apiGet<SpejarenDocument>('api/v1/document', { url })
  const text = doc?.text?.trim()
  if (!doc || !text) return null
  const fetched = doc.fetched_at ? `fetched ${doc.fetched_at.slice(0, 10)}` : null
  const meta = ['spejaren', doc.site?.domain, doc.lang, doc.publishedDate?.slice(0, 10), fetched].filter(Boolean)
  return `[${meta.join(' · ')}]\n${doc.title ? `${doc.title}\n\n` : ''}${text}`
}

/** GET a JSON API path relative to SPEJAREN_URL; null on timeout, error status or bad body.
 *  A 404 is the normal "not indexed" answer from the document endpoint, so it is not logged. */
async function apiGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const base = baseUrl()
  if (!base) return null
  // Relative to a slash-terminated base, so a reverse-proxy path prefix (…/spejaren/) survives.
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const key = process.env.SPEJAREN_API_KEY?.trim()
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeoutMs()),
    })
    if (!res.ok) {
      if (res.status !== 404) console.warn(`  [spejaren] ${path} → HTTP ${res.status}`)
      return null
    }
    return await res.json() as T
  } catch (e) {
    console.warn(`  [spejaren] ${path} failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}
