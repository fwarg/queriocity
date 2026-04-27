import type { SearchResult } from './searxng.ts'
import feedsJson from '../data/news_feeds.json'

const MAX_CONTENT_CHARS = 800
const MAX_ITEMS_PER_FEED = 10
const FETCH_TIMEOUT_MS = 10_000

export interface FeedSource {
  name: string
  country: string
  topic: string
  type: string
  language: string
  ownership: string
  rss_status: string
  rss: string
}

export interface FeedRegion {
  region: string
  sources: FeedSource[]
}

export const FEED_CATALOG: FeedRegion[] = feedsJson as FeedRegion[]

const sourceByName = new Map<string, { source: FeedSource; region: string }>()
for (const r of FEED_CATALOG) {
  for (const s of r.sources) {
    sourceByName.set(s.name, { source: s, region: r.region })
  }
}

function extractTag(block: string, tag: string): string | null {
  // CDATA form
  let re = new RegExp(`<${tag}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i')
  let m = block.match(re)
  if (m) return m[1].trim()
  // Plain content
  re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')
  m = block.match(re)
  if (m) return m[1].trim()
  return null
}

function extractAttrHref(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\shref="([^"]*)"`, 'i')
  const m = block.match(re)
  return m ? m[1] : null
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitItems(xml: string): string[] {
  const items: string[] = []
  let re = /<item[\s>][\s\S]*?<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) items.push(m[0])
  if (items.length > 0) return items
  re = /<entry[\s>][\s\S]*?<\/entry>/gi
  while ((m = re.exec(xml)) !== null) items.push(m[0])
  return items
}

async function fetchFeedItems(source: FeedSource, region: string, maxItems: number, maxContentChars: number): Promise<SearchResult[]> {
  try {
    const res = await fetch(source.rss, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    })
    if (!res.ok) {
      console.warn(`  [rss] ${source.name}: HTTP ${res.status}`)
      return []
    }
    const xml = await res.text()
    const blocks = splitItems(xml).slice(0, maxItems)
    const results: SearchResult[] = []

    for (const block of blocks) {
      const title = stripHtml(extractTag(block, 'title') ?? '').slice(0, 200)
      if (!title) continue

      const url = (
        extractTag(block, 'link')?.trim() ||
        extractAttrHref(block, 'link') ||
        extractTag(block, 'guid')?.trim() ||
        ''
      )

      const rawContent =
        extractTag(block, 'content:encoded') ||
        extractTag(block, 'content') ||
        extractTag(block, 'description') ||
        extractTag(block, 'summary') ||
        ''
      const text = stripHtml(rawContent).slice(0, maxContentChars)

      results.push({
        title,
        url,
        content: `[${source.name} · ${source.topic} · ${source.type} · ${source.ownership} · ${region}]\n${text}`,
      })
    }
    console.log(`  [rss] ${source.name}: ${results.length} items`)
    return results
  } catch (e) {
    console.warn(`  [rss] ${source.name}: fetch failed — ${e instanceof Error ? e.message : e}`)
    return []
  }
}

export async function fetchSelectedFeeds(sourceNames: string[], charsBudget = 50_000): Promise<SearchResult[]> {
  const n = sourceNames.length
  const charsPerSource = charsBudget / n
  const itemsPerFeed = Math.min(MAX_ITEMS_PER_FEED, Math.max(1, Math.round(charsPerSource / MAX_CONTENT_CHARS)))
  const contentChars = Math.min(MAX_CONTENT_CHARS, Math.max(200, Math.floor(charsPerSource / itemsPerFeed)))
  console.log(`  [rss] fetching ${n} sources: up to ${itemsPerFeed} items each, ${contentChars} chars/item (budget=${charsBudget})`)

  const tasks = sourceNames.map(name => {
    const entry = sourceByName.get(name)
    if (!entry) return Promise.resolve<SearchResult[]>([])
    return fetchFeedItems(entry.source, entry.region, itemsPerFeed, contentChars)
  })
  const results = await Promise.all(tasks)
  return results.flat()
}
