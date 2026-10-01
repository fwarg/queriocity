/** spejaren as a search source, asserted against stub servers on the wire: merged in parallel with
 *  SearXNG, exempt from per-domain dedup, and a no-op when slow, failing or unconfigured. */

import { describe, test, expect, afterEach } from 'bun:test'
import { envOverride } from './test-support/env-override.ts'
import { webSearch, trustedSearchMulti } from './searxng.ts'
import { spejarenFilter, spejarenDocument } from './spejaren.ts'
import { fetchUrl } from './fetch-url.ts'

interface Stub { url: string; hits: URL[]; auth: Array<string | null>; stop: () => void }

const cleanups: Array<() => void> = []
afterEach(() => { for (const undo of cleanups.splice(0).reverse()) undo() })

function stub(handler: (req: Request) => Response | Promise<Response>): Stub {
  const hits: URL[] = []
  const auth: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      hits.push(new URL(req.url))
      auth.push(req.headers.get('authorization'))
      return handler(req)
    },
  })
  const s = { url: `http://localhost:${server.port}`, hits, auth, stop: () => server.stop(true) }
  cleanups.push(s.stop)
  return s
}

const searxngStub = (urls: string[], delayMs = 0) => stub(async () => {
  if (delayMs) await Bun.sleep(delayMs)
  return Response.json({ results: urls.map(url => ({ title: 'web', url, content: 'web snippet', engine: 'stub' })) })
})

const spejarenStub = (urls: string[], delayMs = 0) => stub(async () => {
  if (delayMs) await Bun.sleep(delayMs)
  return Response.json({
    ranking: 'keyword',
    results: urls.map((url, i) => ({
      title: 'small', url, content: `passage ${i + 1}`, engine: 'spejaren',
      domain: 'x.se', lang: 'sv', publishedDate: '2025-03-02',
    })),
  })
})

function configure(searxng: Stub, spejaren: Stub | null, extra: Record<string, string> = {}) {
  cleanups.push(envOverride({
    SEARXNG_URL: searxng.url,
    SPEJAREN_URL: spejaren?.url ?? '',
    SPEJAREN_API_KEY: 'key',
    SPEJAREN_COUNT: '3',
    SPEJAREN_TIMEOUT_MS: '3000',
    ...extra,
  }))
}

describe('webSearch with spejaren', () => {
  test('interleaves spejaren hits and keeps several from one site', async () => {
    const searxng = searxngStub(['https://a.com/1', 'https://b.com/1', 'https://a.com/2'])
    const spejaren = spejarenStub(['https://x.se/1', 'https://x.se/2'])
    configure(searxng, spejaren)

    const results = await webSearch('bin', 6)

    // a.com/2 is dropped by the per-domain dedup; the second x.se page is not.
    expect(results.map(r => r.url)).toEqual(['https://a.com/1', 'https://x.se/1', 'https://b.com/1', 'https://x.se/2'])
    expect(results[1].content).toBe('[spejaren · x.se · sv · 2025-03-02]\npassage 1')
    expect(spejaren.auth[0]).toBe('Bearer key')
    expect(spejaren.hits[0].pathname).toBe('/api/v1/search')
    expect(spejaren.hits[0].searchParams.get('q')).toBe('bin')
    expect(spejaren.hits[0].searchParams.get('count')).toBe('3')
    expect(spejaren.hits[0].searchParams.has('filter')).toBe(false)
  })

  test("keeps spejaren's copy when both sources return the same page", async () => {
    const searxng = searxngStub(['https://www.x.se/1/', 'https://a.com/1'])
    const spejaren = spejarenStub(['https://x.se/1'])
    configure(searxng, spejaren)

    const results = await webSearch('bin', 6)

    expect(results.map(r => r.url)).toEqual(['https://a.com/1', 'https://x.se/1'])
    expect(results[1].content).toContain('passage 1')
  })

  test('asks spejaren while SearXNG is still working, not after', async () => {
    const events: string[] = []
    const searxng = stub(async () => {
      events.push('searxng in')
      await Bun.sleep(200)
      events.push('searxng out')
      return Response.json({ results: [] })
    })
    const spejaren = stub(() => {
      events.push('spejaren in')
      return Response.json({ results: [] })
    })
    configure(searxng, spejaren)

    await webSearch('bin', 6)

    expect(events.indexOf('spejaren in')).toBeLessThan(events.indexOf('searxng out'))
  })

  test('a spejaren slower than SPEJAREN_TIMEOUT_MS leaves the SearXNG results alone', async () => {
    const searxng = searxngStub(['https://a.com/1'])
    const spejaren = spejarenStub(['https://x.se/1'], 2000)
    configure(searxng, spejaren, { SPEJAREN_TIMEOUT_MS: '100' })

    const start = performance.now()
    const results = await webSearch('bin', 6)

    expect(results.map(r => r.url)).toEqual(['https://a.com/1'])
    expect(performance.now() - start).toBeLessThan(1500)
  })

  test('an error from spejaren leaves the SearXNG results alone', async () => {
    const searxng = searxngStub(['https://a.com/1'])
    const spejaren = stub(() => new Response('invalid or missing API key', { status: 401 }))
    configure(searxng, spejaren)

    expect((await webSearch('bin', 6)).map(r => r.url)).toEqual(['https://a.com/1'])
  })

  test('still returns spejaren hits when SearXNG fails', async () => {
    const searxng = stub(() => new Response('down', { status: 502 }))
    const spejaren = spejarenStub(['https://x.se/1'])
    configure(searxng, spejaren)

    expect((await webSearch('bin', 6)).map(r => r.url)).toEqual(['https://x.se/1'])
  })

  test('does nothing when SPEJAREN_URL is unset', async () => {
    const searxng = searxngStub(['https://a.com/1'])
    const spejaren = spejarenStub(['https://x.se/1'])
    configure(searxng, null)

    expect((await webSearch('bin', 6)).map(r => r.url)).toEqual(['https://a.com/1'])
    expect(spejaren.hits).toHaveLength(0)
  })

  test('maps the discussion chip to the forums filter', async () => {
    const searxng = searxngStub([])
    const spejaren = spejarenStub([])
    configure(searxng, spejaren)

    await webSearch('bin', 6, 'social media')

    expect(spejaren.hits[0].searchParams.get('filter')).toBe('forums')
  })

  test('skips spejaren for categories it has no index for', async () => {
    const searxng = searxngStub(['https://news.com/1'])
    const spejaren = spejarenStub(['https://x.se/1'])
    configure(searxng, spejaren)

    expect((await webSearch('bin', 6, 'news')).map(r => r.url)).toEqual(['https://news.com/1'])
    expect(spejaren.hits).toHaveLength(0)
  })
})

describe('spejarenFilter', () => {
  test('searches unfiltered without categories or with general', () => {
    expect(spejarenFilter(undefined)).toBe('')
    expect(spejarenFilter('general,news')).toBe('')
  })

  test('maps the chips spejaren has filters for, first one winning', () => {
    expect(spejarenFilter('social media')).toBe('forums')
    expect(spejarenFilter('it')).toBe('docs')
    expect(spejarenFilter('news,it,social media')).toBe('docs')
  })

  test('returns null when no category maps', () => {
    expect(spejarenFilter('news')).toBeNull()
    expect(spejarenFilter('news,science')).toBeNull()
  })
})

describe('trustedSearchMulti', () => {
  test('searches spejaren alone, with the full count per query', async () => {
    const searxng = searxngStub(['https://a.com/1'])
    const spejaren = spejarenStub(['https://x.se/1'])
    configure(searxng, spejaren)

    const results = await trustedSearchMulti(['bin', 'honung'], 8)

    expect(results.map(r => r.url)).toEqual(['https://x.se/1'])
    expect(searxng.hits).toHaveLength(0)
    expect(spejaren.hits.map(h => h.searchParams.get('count'))).toEqual(['8', '8'])
  })

  test('returns nothing when spejaren is not configured', async () => {
    const searxng = searxngStub(['https://a.com/1'])
    configure(searxng, null)

    expect(await trustedSearchMulti(['bin'], 8)).toEqual([])
    expect(searxng.hits).toHaveLength(0)
  })
})

describe('spejarenDocument', () => {
  test('returns the indexed text under a header naming the crawl date', async () => {
    const spejaren = stub(() => Response.json({
      url: 'https://x.se/1', title: 'Bin', lang: 'sv', publishedDate: '2025-03-02',
      fetched_at: '2026-09-10T12:00:00+00:00', text: 'Om bin.', site: { domain: 'x.se' },
    }))
    configure(searxngStub([]), spejaren)

    expect(await spejarenDocument('https://x.se/1')).toBe('[spejaren · x.se · sv · 2025-03-02 · fetched 2026-09-10]\nBin\n\nOm bin.')
    expect(spejaren.hits[0].pathname).toBe('/api/v1/document')
    expect(spejaren.hits[0].searchParams.get('url')).toBe('https://x.se/1')
  })

  test('returns null for a page spejaren has not indexed', async () => {
    const spejaren = stub(() => new Response('not indexed', { status: 404 }))
    configure(searxngStub([]), spejaren)

    expect(await spejarenDocument('https://x.se/unknown')).toBeNull()
  })

  test('keeps a path prefix in SPEJAREN_URL', async () => {
    const spejaren = stub(() => new Response('not indexed', { status: 404 }))
    configure(searxngStub([]), spejaren, { SPEJAREN_URL: `${spejaren.url}/spejaren` })

    await spejarenDocument('https://x.se/1')

    expect(spejaren.hits[0].pathname).toBe('/spejaren/api/v1/document')
  })
})

describe('fetchUrl', () => {
  test("serves spejaren's indexed copy without fetching the page", async () => {
    const text = 'Bin samlar nektar och pollen. '.repeat(20).trim()
    const spejaren = stub(() => Response.json({ title: 'Bin', text, site: { domain: 'example.com' } }))
    configure(searxngStub([]), spejaren)

    // A public IP literal passes the URL guard without DNS; were the copy ignored, it would be fetched live.
    const content = await fetchUrl('http://93.184.215.14/spejaren-test')

    expect(content).toBe(`[spejaren · example.com]\nBin\n\n${text}`)
  })
})
