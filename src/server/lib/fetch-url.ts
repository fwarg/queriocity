import { chromium } from 'playwright'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

const MAX_CHARS = parseInt(process.env.FETCH_MAX_CHARS ?? '12000')
const PROXY_URL = process.env.FETCH_PROXY_URL
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined

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
  const browser = await chromium.launch({ headless: true })
  try {
    const ctx = PROXY_URL
      ? await browser.newContext({ proxy: { server: PROXY_URL } })
      : await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    const text = await page.evaluate(() => document.body.innerText)
    await ctx.close()
    return text.replace(/\s+/g, ' ').trim()
  } finally {
    await browser.close()
  }
}

export async function fetchUrl(url: string): Promise<string> {
  const start = performance.now()
  try {
    const text = await fetchStatic(url)
    if (text.length >= 300) {
      console.log(`  [fetch-url] static ${url} — ${text.length} chars in ${(performance.now() - start).toFixed(0)}ms`)
      return text.slice(0, MAX_CHARS)
    }
    console.log(`  [fetch-url] static fetch short (${text.length} chars), trying Playwright`)
  } catch (err) {
    if (err instanceof HttpError) {
      console.log(`  [fetch-url] HTTP ${err.status} — skipping Playwright`)
      return `Error fetching ${url}: HTTP ${err.status}`
    }
    console.log(`  [fetch-url] static fetch failed: ${err}, trying Playwright`)
  }
  try {
    const text = await fetchWithPlaywright(url)
    console.log(`  [fetch-url] playwright ${url} — ${text.length} chars in ${(performance.now() - start).toFixed(0)}ms`)
    return text.slice(0, MAX_CHARS)
  } catch (err) {
    console.log(`  [fetch-url] playwright failed: ${err}`)
    return `Error fetching ${url}: ${err}`
  }
}
