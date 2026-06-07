import { chromium } from 'playwright'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { YoutubeTranscript } from 'youtube-transcript'

const MAX_CHARS = parseInt(process.env.FETCH_MAX_CHARS ?? '12000')
const PROXY_URL = process.env.FETCH_PROXY_URL
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined
const CACHE_TTL_MS = 5 * 60 * 1000
const fetchCache = new Map<string, { result: string; ts: number }>()
const MAX_PREFETCH_PAGES = parseInt(process.env.FETCH_MAX_PAGES ?? '8')

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(nav|header|footer|aside|menu)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

class HttpError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`) }
}

async function fetchStatic(url: string): Promise<string> {
  const res = await undiciFetch(url, {
    dispatcher: proxyAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new HttpError(res.status)
  const html = await res.text()
  return stripHtml(html)
}

async function fetchWithPlaywright(url: string): Promise<string> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  try {
    const ctxOptions = {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      ...(PROXY_URL ? { proxy: { server: PROXY_URL } } : {}),
    }
    const ctx = await browser.newContext(ctxOptions)
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
    const text = await page.evaluate(() => document.body.innerText)
    await ctx.close()
    return text.replace(/\s+/g, ' ').trim()
  } finally {
    await browser.close()
  }
}

export function extractYoutubeVideoId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0] || null
    if (u.hostname.endsWith('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v')
      const m = u.pathname.match(/\/(?:shorts|embed|v)\/([^/?]+)/)
      if (m) return m[1]
    }
    return null
  } catch { return null }
}

export async function fetchUrl(url: string): Promise<string> {
  const cached = fetchCache.get(url)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`  [fetch-url] cache hit: ${url}`)
    return cached.result
  }
  const start = performance.now()
  const cache = (result: string) => { fetchCache.set(url, { result, ts: Date.now() }); return result }

  const videoId = extractYoutubeVideoId(url)
  if (videoId) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(videoId)
      const text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim()
      console.log(`  [fetch-url] youtube transcript ${videoId} — ${text.length} chars in ${(performance.now() - start).toFixed(0)}ms`)
      return cache(text.slice(0, MAX_CHARS))
    } catch (e) {
      console.log(`  [fetch-url] youtube transcript failed (${e}), falling back to static fetch`)
    }
  }

  try {
    const text = await fetchStatic(url)
    if (text.length >= 300) {
      console.log(`  [fetch-url] static ${url} — ${text.length} chars in ${(performance.now() - start).toFixed(0)}ms`)
      return cache(text.slice(0, MAX_CHARS))
    }
    console.log(`  [fetch-url] static fetch short (${text.length} chars), trying Playwright`)
  } catch (err) {
    if (err instanceof HttpError && proxyAgent) {
      // With a proxy (Tor), HTTP errors mean the exit node is blocked — Playwright would also fail or timeout
      console.log(`  [fetch-url] HTTP ${err.status} via proxy — skipping Playwright`)
      return cache(`Error fetching ${url}: HTTP ${err.status}`)
    }
    console.log(`  [fetch-url] static fetch failed: ${err}, trying Playwright`)
  }
  try {
    const text = await fetchWithPlaywright(url)
    console.log(`  [fetch-url] playwright ${url} — ${text.length} chars in ${(performance.now() - start).toFixed(0)}ms`)
    return cache(text.slice(0, MAX_CHARS))
  } catch (err) {
    console.log(`  [fetch-url] playwright failed: ${err}`)
    return cache(`Error fetching ${url}: ${err}`)
  }
}

function buildPageUrl(url: string, page: number): string {
  const u = new URL(url)
  u.searchParams.set('page', String(page))
  return u.toString()
}

export async function fetchUrlAllPages(url: string): Promise<string> {
  console.log(`  [fetch-url] page 1: ${url}`)
  const first = await fetchUrl(url)
  if (first.startsWith('Error')) return first

  const pages = [first]
  const seen = new Set([first])
  for (let p = 2; p <= MAX_PREFETCH_PAGES; p++) {
    const pageUrl = buildPageUrl(url, p)
    console.log(`  [fetch-url] page ${p}: ${pageUrl}`)
    const content = await fetchUrl(pageUrl)
    if (content.startsWith('Error') || content.length < 300) {
      console.log(`  [fetch-url] page ${p} empty/error — stopping at ${p - 1} pages`)
      break
    }
    if (seen.has(content)) {
      console.log(`  [fetch-url] page ${p} duplicate — site ignores page param, stopping at ${p - 1} pages`)
      break
    }
    seen.add(content)
    pages.push(content)
  }

  console.log(`  [fetch-url] fetched ${pages.length} page(s) total for ${url}`)
  if (pages.length === 1) return first
  return pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join('\n\n')
}
