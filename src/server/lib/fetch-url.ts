import { chromium } from 'playwright'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { YoutubeTranscript } from 'youtube-transcript'
import { generateText } from 'ai'
import { getSmallModel } from './llm.ts'

const MAX_CHARS = parseInt(process.env.FETCH_MAX_CHARS ?? '12000')
const PROXY_URL = process.env.FETCH_PROXY_URL
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined
const CACHE_TTL_MS = 5 * 60 * 1000
const fetchCache = new Map<string, { result: string; ts: number }>()
const DEFAULT_MAX_PAGES = parseInt(process.env.FETCH_MAX_PAGES ?? '8')

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

export async function fetchUrlAllPages(url: string, maxPages = DEFAULT_MAX_PAGES): Promise<string> {
  console.log(`  [fetch-url] page 1: ${url}`)
  const first = await fetchUrl(url)
  if (first.startsWith('Error')) return first

  const limit = maxPages === 0 ? Infinity : maxPages
  const pages = [first]
  const seen = new Set([first])
  for (let p = 2; p <= limit; p++) {
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
    // Same length as previous page = near-duplicate (e.g. file-listing pagination with same structure)
    if (content.length === pages[pages.length - 1].length) {
      console.log(`  [fetch-url] page ${p} same length as previous — non-content pagination, stopping at ${p - 1} pages`)
      break
    }
    seen.add(content)
    pages.push(content)
  }

  console.log(`  [fetch-url] fetched ${pages.length} page(s) total for ${url}`)
  if (pages.length === 1) return first
  return pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join('\n\n')
}

// Derive chunk size from the small model's context window.
// Reserve 30% for system prompt + output; use 2.5 chars/tok for dense technical content.
const SMALL_CTX = parseInt(process.env.SMALL_MODEL_CONTEXT_TOKENS ?? '4096')
const SUMMARIZE_INPUT_CHARS = Math.floor(SMALL_CTX * 0.7 * 2.5)
// Max chunks to process serially (covers up to MAX_SUMMARIZE_CHUNKS × SUMMARIZE_INPUT_CHARS chars)
const MAX_SUMMARIZE_CHUNKS = parseInt(process.env.FETCH_SUMMARIZE_MAX_CHUNKS ?? '6')
// Hard cap per URL regardless of budget — prevents one URL from consuming the whole context
const MAX_URL_CONTEXT_CHARS = parseInt(process.env.FETCH_MAX_URL_CONTEXT_CHARS ?? '40000')

export async function summarizeContent(url: string, content: string, targetChars: number): Promise<string> {
  const hostname = new URL(url).hostname
  const start = performance.now()
  const numChunks = Math.min(MAX_SUMMARIZE_CHUNKS, Math.ceil(content.length / SUMMARIZE_INPUT_CHARS))
  const perChunkWords = Math.floor(targetChars / numChunks / 5)
  const summaries: string[] = []
  try {
    for (let i = 0; i < numChunks; i++) {
      const chunk = content.slice(i * SUMMARIZE_INPUT_CHARS, (i + 1) * SUMMARIZE_INPUT_CHARS)
      const { text } = await generateText({
        model: getSmallModel(),
        system: `Summarize this section of a web page concisely, preserving all technically important facts. Reply in under ${perChunkWords} words. Output only the summary, no preamble.`,
        prompt: chunk,
      })
      summaries.push(text)
    }
    const combined = summaries.join('\n\n')
    console.log(`  [fetch-url] summarised ${hostname}: ${content.length} → ${combined.length} chars (${numChunks} chunks) in ${(performance.now() - start).toFixed(0)}ms`)
    return combined
  } catch (err) {
    console.warn(`  [fetch-url] summarise failed for ${hostname}: ${err}`)
    return content.slice(0, targetChars) + '\n[content truncated to fit context]'
  }
}

export async function processUrlsForContext(
  urls: Array<{ url: string; content: string }>,
  budgetChars: number,
  summarize: boolean,
): Promise<Array<{ url: string; content: string }>> {
  if (!urls.length) return urls
  const perUrlChars = Math.min(MAX_URL_CONTEXT_CHARS, Math.max(8000, Math.floor(budgetChars / urls.length)))
  return Promise.all(urls.map(async ({ url, content }) => {
    if (content.length <= perUrlChars) return { url, content }
    const hostname = new URL(url).hostname
    if (summarize) {
      return { url, content: await summarizeContent(url, content, perUrlChars) }
    }
    const truncated = content.slice(0, perUrlChars) + '\n[content truncated to fit context]'
    console.log(`  [fetch-url] content for ${hostname}: ${content.length} → ${truncated.length} chars (truncated)`)
    return { url, content: truncated }
  }))
}
