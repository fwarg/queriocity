import { describe, test, expect } from 'bun:test'
import { rrfFuse, interleaveSupplements, type ProviderRun } from './fusion.ts'
import { envPolicy, mergePolicy, engineWeight, hasMajorEngineList, type ProviderPolicy } from './policy.ts'
import type { SearchProvider } from './types.ts'

const policy = (over: Partial<ProviderPolicy> = {}): ProviderPolicy => ({
  enabled: true, role: 'primary', weight: 1, minSlots: 0, trustedForLocked: false, monthlyQuota: 0,
  engineWeights: {}, defaultEngineWeight: 1, ...over,
})

const provider = (id: string, passageHits = false): SearchProvider => ({
  id, label: id, kind: 'api', passageHits, envVars: [], isConfigured: () => true,
  search: async () => ({ results: [], engines: new Set(), errors: [], failed: false }),
})

const run = (id: string, urls: string[], p: Partial<ProviderPolicy> = {}, passageHits = false, engines?: string[]): ProviderRun => ({
  provider: provider(id, passageHits),
  policy: policy(p),
  results: urls.map(url => ({ title: id, url, content: `${id} snippet`, engines })),
})

const urls = (rs: Array<{ url: string }>) => rs.map(r => r.url)

describe('rrfFuse', () => {
  test('a page several providers return outranks one only a single provider ranks first', () => {
    const fused = rrfFuse('q', 10, [
      run('a', ['https://solo.com/1', 'https://both.com/1']),
      run('b', ['https://other.com/1', 'https://both.com/1']),
    ], 60)
    expect(urls(fused)[0]).toBe('https://both.com/1')
  })

  test('weights scale a provider\'s pull', () => {
    const fused = rrfFuse('q', 10, [
      run('light', ['https://light.com/1'], { weight: 0.2 }),
      run('heavy', ['https://heavy.com/1'], { weight: 2 }),
    ], 60)
    expect(urls(fused)).toEqual(['https://heavy.com/1', 'https://light.com/1'])
  })

  test('sub-engine weights apply to a meta-engine\'s hits', () => {
    const p = { engineWeights: { google: 1 }, defaultEngineWeight: 0.1 }
    const fused = rrfFuse('q', 10, [
      run('meta', ['https://niche.com/1'], p, false, ['marginalia']),
      run('meta2', ['https://broad.com/1'], p, false, ['google']),
    ], 60)
    expect(urls(fused)[0]).toBe('https://broad.com/1')
  })

  test('reserves minSlots for a provider that would otherwise be cut', () => {
    const fused = rrfFuse('q', 3, [
      run('big', ['https://a.com/1', 'https://b.com/1', 'https://c.com/1'], { weight: 5 }),
      run('small', ['https://x.se/1', 'https://y.se/1'], { weight: 0.1, minSlots: 1 }),
    ], 60)
    expect(fused).toHaveLength(3)
    expect(urls(fused)).toContain('https://x.se/1')
  })

  test('dedups by domain, except passage hits and site: queries', () => {
    const runs = [
      run('web', ['https://a.com/1', 'https://a.com/2']),
      run('index', ['https://x.se/1', 'https://x.se/2'], {}, true),
    ]
    expect(urls(rrfFuse('q', 10, runs, 60)).sort()).toEqual(['https://a.com/1', 'https://x.se/1', 'https://x.se/2'])
    expect(rrfFuse('site:a.com q', 10, runs, 60)).toHaveLength(4)
  })

  test('keeps the passage provider\'s copy of a shared page', () => {
    const fused = rrfFuse('q', 10, [
      run('web', ['https://x.se/1'], { weight: 5 }),
      run('index', ['https://www.x.se/1/'], {}, true),
    ], 60)
    expect(fused).toEqual([{ title: 'index', url: 'https://www.x.se/1/', content: 'index snippet' }])
  })
})

describe('interleaveSupplements', () => {
  test('alternates the lists and lets a supplement\'s copy replace the base one', () => {
    const base = ['https://a.com/1', 'https://b.com/1'].map(url => ({ title: 'web', url, content: '' }))
    const supp = ['https://b.com/1', 'https://x.se/1'].map(url => ({ title: 'idx', url, content: '' }))
    expect(interleaveSupplements(base, [supp]).map(r => `${r.title} ${r.url}`)).toEqual([
      'web https://a.com/1', 'idx https://b.com/1', 'idx https://x.se/1',
    ])
  })
})

describe('policy', () => {
  test('stored fields override env defaults per provider, leaving the rest', () => {
    const merged = mergePolicy(envPolicy(), { fusion: 'rrf', providers: { spejaren: { weight: 3 } } })
    expect(merged.fusion).toBe('rrf')
    expect(merged.providers.spejaren.weight).toBe(3)
    expect(merged.providers.spejaren.role).toBe('supplement')
    expect(merged.providers.searxng.role).toBe('primary')
  })

  test('engine weights match SearXNG variant names by their first token', () => {
    const p = policy({ engineWeights: { brave: 1 }, defaultEngineWeight: 0.5 })
    expect(engineWeight(p, 'brave.news')).toBe(1)
    expect(engineWeight(p, 'marginalia')).toBe(0.5)
    expect(hasMajorEngineList(p)).toBe(true)
    expect(hasMajorEngineList(policy())).toBe(false)
  })
})
