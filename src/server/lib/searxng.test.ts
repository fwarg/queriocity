import { describe, test, expect } from 'bun:test'

// Set before first use: the engine list is memoised on first read, and Bun auto-loads the local
// .env — without this the test would assert against whatever the developer has configured.
process.env.SEARCH_MAJOR_ENGINES = 'google,bing,brave,duckduckgo,startpage,mojeek,reuters'
const { isMajorEngine, isSiteScoped, hasMajorEngineList } = await import('./searxng.ts')

describe('isMajorEngine', () => {
  test('matches configured engines by exact name', () => {
    for (const e of ['brave', 'duckduckgo', 'startpage', 'mojeek', 'google', 'reuters']) {
      expect(isMajorEngine(e)).toBe(true)
    }
  })

  test('matches SearXNG variant names, which are suffixed after their parent', () => {
    // Real engine names from a live config; exact-match alone would classify these as niche
    // and trigger an unnecessary paid top-up.
    for (const e of ['brave.news', 'bing news', 'startpage news', 'google scholar']) {
      expect(isMajorEngine(e)).toBe(true)
    }
  })

  test('treats engines outside the list as non-major', () => {
    for (const e of ['marginalia', 'wiby', 'arxiv', 'piped.music', 'stackoverflow']) {
      expect(isMajorEngine(e)).toBe(false)
    }
  })

  test('reports that a list is configured', () => {
    expect(hasMajorEngineList()).toBe(true)
  })
})

describe('isSiteScoped', () => {
  test('detects site: restriction', () => {
    expect(isSiteScoped('site:bbc.com news')).toBe(true)
    expect(isSiteScoped('news site:cnn.com august')).toBe(true)
  })

  test('ignores unrelated or empty site: text', () => {
    expect(isSiteScoped('best website builders')).toBe(false)
    expect(isSiteScoped('what is a site')).toBe(false)
    expect(isSiteScoped('site: ')).toBe(false)
  })
})
