/** Search limits — monthly provider quotas and the per-request query cap — plus SearXNG infoboxes,
 *  asserted against a stub SearXNG on the wire. */

import { describe, test, expect, afterEach, afterAll } from 'bun:test'
import { envOverride } from '../test-support/env-override.ts'
import { webSearch, webSearchMulti, newSearchBudget } from './index.ts'
import { envPolicy, mergePolicy, saveSearchPolicy, resetSearchPolicy } from './policy.ts'
import { takeQuota, hasQuota, monthlyUsage } from './usage.ts'
import { infoboxResults } from './providers/searxng.ts'
import { telemetrySnapshot } from './telemetry.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const undo of cleanups.splice(0).reverse()) undo() })
// The in-memory database is shared by every test file; a stored policy would change their searches.
afterAll(resetSearchPolicy)

function searxngStub(body: object = { results: [{ title: 'web', url: 'https://a.com/1', content: 'x', engine: 'stub' }] }) {
  const hits: string[] = []
  const server = Bun.serve({ port: 0, fetch: (req) => { hits.push(new URL(req.url).searchParams.get('q') ?? ''); return Response.json(body) } })
  cleanups.push(() => server.stop(true))
  cleanups.push(envOverride({ SEARXNG_URL: `http://localhost:${server.port}`, SPEJAREN_URL: '', SEARCH_API_PROVIDER: '' }))
  return hits
}

describe('monthly quota', () => {
  test('allows calls up to the quota, then refuses for the rest of the month', () => {
    const now = new Date('2031-05-10T12:00:00Z')
    expect(takeQuota('quota-test', 2, now)).toBe(true)
    expect(takeQuota('quota-test', 2, now)).toBe(true)
    expect(takeQuota('quota-test', 2, now)).toBe(false)
    expect(takeQuota('quota-test', 2, new Date('2031-06-01T00:00:00Z'))).toBe(true)
  })

  test('0 means unlimited, and still counts', () => {
    for (let i = 0; i < 5; i++) expect(takeQuota('unlimited-test', 0)).toBe(true)
    expect(hasQuota('unlimited-test', 0)).toBe(true)
    expect(monthlyUsage()['unlimited-test']).toBe(5)
  })

  test('a provider over its quota is skipped by webSearch', async () => {
    const hits = searxngStub()
    // Other files' searches count too, so the quota is set relative to this month's usage.
    const used = monthlyUsage().searxng ?? 0
    await saveSearchPolicy(mergePolicy(envPolicy(), { providers: { searxng: { monthlyQuota: used + 1 } } }))

    expect(await webSearch('first')).toHaveLength(1)
    expect(await webSearch('second')).toEqual([])
    expect(hits).toEqual(['first'])
    await resetSearchPolicy()
  })
})

describe('queries per request', () => {
  test('caps the queries a request may run, across calls', async () => {
    const hits = searxngStub()
    await saveSearchPolicy(mergePolicy(envPolicy(), { maxQueriesPerRequest: 2 }))
    const budget = await newSearchBudget()

    await webSearchMulti(['one', 'two', 'three'], 5, undefined, undefined, budget)
    expect(await webSearch('four', 5, undefined, undefined, budget)).toEqual([])
    expect(hits.sort()).toEqual(['one', 'two'])
    await resetSearchPolicy()
  })

  test('is unlimited by default', async () => {
    expect((await newSearchBudget()).queriesRemaining).toBe(Infinity)
  })
})

describe('provider failures', () => {
  test('are kept with their reason, and a success clears the failing state', async () => {
    let fail = true
    const server = Bun.serve({ port: 0, fetch: () => fail ? new Response('down', { status: 502 }) : Response.json({ results: [] }) })
    cleanups.push(() => server.stop(true))
    cleanups.push(envOverride({ SEARXNG_URL: `http://localhost:${server.port}`, SPEJAREN_URL: '', SEARCH_API_PROVIDER: '' }))

    await webSearch('down')
    expect(telemetrySnapshot().searxng.consecutiveFailures).toBeGreaterThan(0)
    expect(telemetrySnapshot().searxng.lastError?.reason).toBe('HTTP 502')

    fail = false
    await webSearch('up')
    expect(telemetrySnapshot().searxng.consecutiveFailures).toBe(0)
    expect(telemetrySnapshot().searxng.lastError?.reason).toBe('HTTP 502')
  })
})

describe('SearXNG infoboxes', () => {
  test('become a result carrying the extract, ahead of the list results', async () => {
    searxngStub({
      results: [{ title: 'Other', url: 'https://b.com/1', content: 'list', engine: 'bing' }],
      infoboxes: [{ infobox: 'Narendra Modi', id: 'https://en.wikipedia.org/wiki/Narendra_Modi', content: 'Prime Minister of India since 2014…', engine: 'wikipedia' }],
    })
    const results = await webSearch('narendra modi')
    expect(results[0]).toEqual({ title: 'Narendra Modi', url: 'https://en.wikipedia.org/wiki/Narendra_Modi', content: 'Prime Minister of India since 2014…' })
    expect(results).toHaveLength(2)
  })

  test('without a URL or text are dropped', () => {
    expect(infoboxResults([{ infobox: 'x', content: 'text' }, { infobox: 'y', id: 'https://w.org/y', content: ' ' }])).toEqual([])
    expect(infoboxResults([{ infobox: 'z', id: 'Q42', urls: [{ url: 'https://wikidata.org/Q42' }], content: 'z' }])[0].url).toBe('https://wikidata.org/Q42')
  })
})
