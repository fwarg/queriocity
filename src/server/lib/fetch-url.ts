import { chromium, type Browser, type BrowserContext } from 'playwright'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { YoutubeTranscript } from 'youtube-transcript'
import { generateText } from 'ai'
import { getSmallModel, SMALL_MODEL_INPUT_CHARS } from './llm.ts'
import { assertFetchableUrl, BlockedUrlError } from './url-guard.ts'

const MAX_CHARS = parseInt(process.env.FETCH_MAX_CHARS ?? '100000')
// Hard ceiling on bytes read off the wire, well above MAX_CHARS to leave room for markup:
// the char cap is applied after stripping, so without this a huge page is fully buffered first.
const MAX_BODY_BYTES = MAX_CHARS * 5
const MAX_REDIRECTS = 5
const PROXY_URL = process.env.FETCH_PROXY_URL
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined
const CACHE_TTL_MS = 5 * 60 * 1000
const fetchCache = new Map<string, { result: string; ts: number }>()
// Entries hold whole page bodies, so this is a memory bound, not just hygiene.
const FETCH_CACHE_MAX_ENTRIES = 200
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

/** Reads a body up to MAX_BODY_BYTES, then abandons the rest of the stream. */
async function readCapped(res: { body: ReadableStream<Uint8Array> | null; text: () => Promise<string> }): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return res.text()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  await reader.cancel().catch(() => {})
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** Redirects are followed manually so every hop can be re-checked: a single guard on the
 *  original URL is trivially bypassed by a public page that 302s to an internal address. */
async function fetchStatic(url: string): Promise<string> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await undiciFetch(current, {
      dispatcher: proxyAgent,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new HttpError(res.status)
      current = new URL(location, current).toString()
      await assertFetchableUrl(current)
      continue
    }
    if (!res.ok) throw new HttpError(res.status)
    return stripHtml(await readCapped(res as unknown as { body: ReadableStream<Uint8Array> | null; text: () => Promise<string> }))
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`)
}

// Chromium takes ~1s to start, so it is launched once and shared; each fetch still gets its
// own context, keeping cookies and storage isolated between pages. Closed again after an idle
// period so a mostly-static path doesn't hold a browser resident forever.
const BROWSER_IDLE_MS = 5 * 60 * 1000
let sharedBrowser: Browser | null = null
let browserIdleTimer: ReturnType<typeof setTimeout> | null = null
let activeContexts = 0

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser
  sharedBrowser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  console.log('  [fetch-url] launched shared chromium')
  return sharedBrowser
}

function scheduleBrowserClose(): void {
  if (browserIdleTimer) clearTimeout(browserIdleTimer)
  browserIdleTimer = setTimeout(() => {
    if (activeContexts > 0 || !sharedBrowser) return
    const browser = sharedBrowser
    sharedBrowser = null
    browser.close()
      .then(() => console.log('  [fetch-url] closed idle chromium'))
      .catch(() => {})
  }, BROWSER_IDLE_MS)
  browserIdleTimer.unref?.()
}

async function fetchWithPlaywright(url: string): Promise<string> {
  const browser = await getBrowser()
  activeContexts++
  let ctx: BrowserContext | null = null
  try {
    const ctxOptions = {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      ...(PROXY_URL ? { proxy: { server: PROXY_URL } } : {}),
    }
    ctx = await browser.newContext(ctxOptions)
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
    // Playwright follows redirects internally, so guard each navigation rather than only the
    // entry URL. Subresources are left alone — their bodies never reach the caller.
    await ctx.route('**/*', async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue()
      try {
        await assertFetchableUrl(route.request().url())
        await route.continue()
      } catch {
        console.warn(`  [fetch-url] blocked playwright navigation to ${route.request().url()}`)
        await route.abort('blockedbyclient')
      }
    })
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
    const text = await page.evaluate(() => document.body.innerText)
    return text.replace(/\s+/g, ' ').trim()
  } finally {
    // The browser outlives this call now, so the context must always be released — a failed
    // goto would otherwise leak a live context for the process lifetime.
    await ctx?.close().catch(() => {})
    activeContexts--
    scheduleBrowserClose()
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
  try {
    await assertFetchableUrl(url)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`  [fetch-url] blocked ${url} — ${reason}`)
    return `Error fetching ${url}: ${reason}`
  }

  const cached = fetchCache.get(url)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`  [fetch-url] cache hit: ${url}`)
    return cached.result
  }
  const start = performance.now()
  const cache = (result: string) => {
    const now = Date.now()
    if (fetchCache.size >= FETCH_CACHE_MAX_ENTRIES) {
      for (const [k, v] of fetchCache) if (now - v.ts >= CACHE_TTL_MS) fetchCache.delete(k)
      if (fetchCache.size >= FETCH_CACHE_MAX_ENTRIES) fetchCache.clear()
    }
    fetchCache.set(url, { result, ts: now })
    return result
  }

  const videoId = extractYoutubeVideoId(url)
  if (videoId) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(videoId)
      const text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim()
      const result = text.slice(0, MAX_CHARS)
      console.log(`  [fetch-url] youtube transcript ${videoId} — ${result.length}${text.length > MAX_CHARS ? ` chars (truncated from ${text.length})` : ' chars'} in ${(performance.now() - start).toFixed(0)}ms`)
      return cache(result)
    } catch (e) {
      console.log(`  [fetch-url] youtube transcript failed (${e}), falling back to static fetch`)
    }
  }

  try {
    const text = await fetchStatic(url)
    if (text.length >= 300) {
      const result = text.slice(0, MAX_CHARS)
      console.log(`  [fetch-url] static ${url} — ${result.length}${text.length > MAX_CHARS ? ` chars (truncated from ${text.length})` : ' chars'} in ${(performance.now() - start).toFixed(0)}ms`)
      return cache(result)
    }
    console.log(`  [fetch-url] static fetch short (${text.length} chars), trying Playwright`)
  } catch (err) {
    // A blocked redirect target must not fall through to Playwright, which would follow it.
    if (err instanceof BlockedUrlError) {
      console.warn(`  [fetch-url] blocked redirect from ${url} — ${err.message}`)
      return `Error fetching ${url}: ${err.message}`
    }
    if (err instanceof HttpError && proxyAgent) {
      // With a proxy (Tor), HTTP errors mean the exit node is blocked — Playwright would also fail or timeout
      console.log(`  [fetch-url] HTTP ${err.status} via proxy — skipping Playwright`)
      return cache(`Error fetching ${url}: HTTP ${err.status}`)
    }
    console.log(`  [fetch-url] static fetch failed: ${err}, trying Playwright`)
  }
  try {
    const text = await fetchWithPlaywright(url)
    const result = text.slice(0, MAX_CHARS)
    console.log(`  [fetch-url] playwright ${url} — ${result.length}${text.length > MAX_CHARS ? ` chars (truncated from ${text.length})` : ' chars'} in ${(performance.now() - start).toFixed(0)}ms`)
    return cache(result)
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

// Max chunks to process serially (covers up to MAX_SUMMARIZE_CHUNKS × SMALL_MODEL_INPUT_CHARS chars)
const MAX_SUMMARIZE_CHUNKS = parseInt(process.env.FETCH_SUMMARIZE_MAX_CHUNKS ?? '6')
// Hard cap per URL regardless of budget — prevents one URL from consuming the whole context
const MAX_URL_CONTEXT_CHARS = parseInt(process.env.FETCH_MAX_URL_CONTEXT_CHARS ?? '40000')
// Floor per URL when a budget is split across many URLs — below this, summarizing/truncating isn't worth it
export const MIN_URL_CONTEXT_CHARS = 8000

if (MAX_CHARS < MAX_URL_CONTEXT_CHARS) {
  console.warn(`[fetch-url] misconfiguration: FETCH_MAX_CHARS (${MAX_CHARS}) is less than FETCH_MAX_URL_CONTEXT_CHARS (${MAX_URL_CONTEXT_CHARS}). The raw scrape ceiling will clip content before the context cap or summarizer ever run, effectively disabling both for single-page fetches. Set FETCH_MAX_CHARS >= FETCH_MAX_URL_CONTEXT_CHARS.`)
}

export async function summarizeContent(url: string, content: string, targetChars: number): Promise<string> {
  const hostname = new URL(url).hostname
  const start = performance.now()
  const numChunks = Math.min(MAX_SUMMARIZE_CHUNKS, Math.ceil(content.length / SMALL_MODEL_INPUT_CHARS))
  const perChunkWords = Math.floor(targetChars / numChunks / 5)
  const summaries: string[] = []
  try {
    for (let i = 0; i < numChunks; i++) {
      const chunk = content.slice(i * SMALL_MODEL_INPUT_CHARS, (i + 1) * SMALL_MODEL_INPUT_CHARS)
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
  const perUrlChars = Math.min(MAX_URL_CONTEXT_CHARS, Math.max(MIN_URL_CONTEXT_CHARS, Math.floor(budgetChars / urls.length)))
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
