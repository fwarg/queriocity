/** Budget/ordering rules for memory injection.
 *
 *  `selectMemories` is deliberately pure so the part that decides *what the model sees* can be
 *  tested without an embedder, a reranker or a database. The ranking itself (KNN + optional
 *  rerank) is exercised end-to-end; what is easy to get silently wrong — and what these cover —
 *  is the budget arithmetic and the guarantee that pinned/always-keep entries survive it. */

// Must precede the ./memory.ts import — it reaches lib/db.ts, which opens DB_PATH at load.
import './test-support/test-env.ts'

import { describe, test, expect } from 'bun:test'
import { selectMemories, isSensitiveFact, isDurableUserFact, mapFactCitations, pickFallbackSources, MEMORY_MAX_SOURCES, type MemoryCandidate, type MemorySource, type RankableSource } from './memory.ts'

/** ~1 token per 4 chars, matching the estimate selectMemories uses. */
const mem = (id: string, tokens: number): MemoryCandidate =>
  ({ id, content: 'x'.repeat(tokens * 4 - 2) }) // -2 for the "- " prefix

describe('selectMemories', () => {
  test('fills the budget from the ranked list in order', () => {
    const ranked = [mem('a', 10), mem('b', 10), mem('c', 10)]
    const { chosen } = selectMemories([], ranked, 25)

    expect(chosen.map(m => m.id)).toEqual(['a', 'b'])
  })

  test('guaranteed memories are injected before ranked ones', () => {
    const { chosen } = selectMemories([mem('pinned', 10)], [mem('a', 10), mem('b', 10)], 25)

    // The pin must win the budget race even though 'a' outranks it on relevance.
    expect(chosen.map(m => m.id)).toEqual(['pinned', 'a'])
  })

  test('reports guaranteed memories that could not fit rather than dropping them silently', () => {
    const { chosen, droppedGuaranteed } = selectMemories([mem('big', 50)], [mem('a', 5)], 20)

    expect(chosen.map(m => m.id)).toEqual(['a'])
    expect(droppedGuaranteed).toBe(1)
  })

  test('skips an oversized entry but keeps filling with smaller ones', () => {
    // A single long memory must not truncate everything after it, which a `break` would do.
    const { chosen } = selectMemories([], [mem('huge', 100), mem('small', 5)], 20)

    expect(chosen.map(m => m.id)).toEqual(['small'])
  })

  test('returns nothing when the budget is exhausted', () => {
    const { chosen } = selectMemories([], [mem('a', 10)], 0)

    expect(chosen).toEqual([])
  })
})

describe('mapFactCitations', () => {
  const src: MemorySource[] = [
    { url: 'https://a.example/1', title: 'A' },
    { url: 'https://b.example/2', title: 'B' },
    { url: 'https://c.example/3', title: 'C' },
  ]

  test('maps a single marker to its source and strips it from the text', () => {
    const f = mapFactCitations('Postgres 17 is the current stable release [2].', src)
    expect(f.text).toBe('Postgres 17 is the current stable release.')
    expect(f.sources).toEqual([src[1]])
  })

  test('normalises a grouped citation and does not double punctuation', () => {
    const f = mapFactCitations('The spec was ratified in 2024 [1, 3].', src)
    expect(f.text).toBe('The spec was ratified in 2024.')
    expect(f.sources).toEqual([src[0], src[2]])
  })

  test('a line with no marker leaves sources undefined for the caller to fill', () => {
    const f = mapFactCitations('The user prefers pnpm over npm.', src)
    expect(f.text).toBe('The user prefers pnpm over npm.')
    expect(f.sources).toBeUndefined()
  })

  test('markers that resolve to nothing give an empty list, not a fallback', () => {
    const f = mapFactCitations('Something cited badly [9].', src.slice(0, 2))
    expect(f.text).toBe('Something cited badly.')
    expect(f.sources).toEqual([])
  })

  test('caps the number of marker sources', () => {
    const many: MemorySource[] = Array.from({ length: 9 }, (_, i) => ({ url: `https://x${i}.example`, title: `X${i}` }))
    const f = mapFactCitations('Lots of citations [1][2][3][4][5][6][7][8][9].', many)
    expect(f.sources).toHaveLength(MEMORY_MAX_SOURCES)
  })

  test('file labels are stripped from text and never mapped', () => {
    const f = mapFactCitations('Drawn from an uploaded doc [F1] and a page [2].', src)
    expect(f.text).toBe('Drawn from an uploaded doc and a page.')
    expect(f.sources).toEqual([src[1]])
  })

  test('a repeated marker yields one source', () => {
    const f = mapFactCitations('Backed twice [2][2].', src)
    expect(f.sources).toEqual([src[1]])
  })
})

describe('pickFallbackSources (no reranker configured)', () => {
  test('a short list passes through untouched', async () => {
    const pool: RankableSource[] = [
      { url: 'https://a.example', title: 'A' },
      { url: 'https://b.example', title: 'B' },
    ]
    expect(await pickFallbackSources('any note', pool)).toEqual(pool)
  })

  test('a long list is deduped, sorted by citation index and capped', async () => {
    const pool: RankableSource[] = [
      { url: 'https://5.example', title: '5', index: 5 },
      { url: 'https://1.example', title: '1', index: 1 },
      { url: 'https://1.example', title: '1 dupe', index: 1 },
      { url: 'https://9.example', title: '9', index: 9 },
      { url: 'https://2.example', title: '2', index: 2 },
      { url: 'https://3.example', title: '3', index: 3 },
      { url: 'https://4.example', title: '4', index: 4 },
      { url: 'https://8.example', title: '8', index: 8 },
    ]
    const picked = await pickFallbackSources('a note', pool)
    expect(picked).toHaveLength(MEMORY_MAX_SOURCES)
    expect(picked.map(s => s.url)).toEqual([
      'https://1.example', 'https://2.example', 'https://3.example',
      'https://4.example', 'https://5.example',
    ])
  })
})

describe('isSensitiveFact', () => {
  // Anything true here would otherwise be offered as a one-click addition to a profile that is
  // injected into every future prompt.
  test.each([
    ['an email address', 'The user can be reached at fredrik.warg@example.com'],
    ['a phone number', 'The user\'s number is +46 70 123 45 67'],
    ['an API key', 'The user\'s token is sk-abcdef0123456789abcdef'],
    ['a long opaque blob', `The key is ${'A1b2C3d4'.repeat(6)}`],
  ])('rejects %s', (_label, fact) => {
    expect(isSensitiveFact(fact)).toBe(true)
  })

  test.each([
    ['a language preference', 'The user works in Swedish and English'],
    ['a tooling constraint', 'The user self-hosts everything and avoids cloud services'],
    ['a formatting preference', 'The user wants concise answers with sources cited inline'],
    ['a date, which is not an identifier', 'The user started the project in March 2026'],
  ])('allows %s', (_label, fact) => {
    expect(isSensitiveFact(fact)).toBe(false)
  })
})

describe('isDurableUserFact', () => {
  // Every rejected case below was actually proposed by a 100-chat scan: two conversations (an
  // hardware thread and a regulation thread) supplied almost the whole list, none of it about the
  // person. The prompt asks for traits; this is the check that does not rely on the model obeying.
  test.each([
    ['a fact about a product', 'The XR-9000 processor has 16 cores'],
    ['a fact about the world', 'The CEO of Acme Corp stepped down in March'],
    ['a topic summary', 'The new AI regulation introduces risk tiers for AI systems'],
    ['something that happened once', 'The user asked about the core count of the XR-9000'],
    ['a conversation recap', 'The user discussed AI regulation in this conversation'],
    ['a reported statement', 'The user mentioned that the deadline is in November'],
  ])('rejects %s', (_label, fact) => {
    expect(isDurableUserFact(fact)).toBe(false)
  })

  test.each([
    ['a language preference', 'The user writes in Swedish and English'],
    ['an infrastructure constraint', 'The user self-hosts everything and avoids cloud services'],
    ['a role', 'The user is a software engineer working on developer tooling'],
    ['a formatting preference', 'The user wants concise answers with inline citations'],
    ['a bare "User" prefix', 'User prefers dark mode across all applications'],
  ])('accepts %s', (_label, fact) => {
    expect(isDurableUserFact(fact)).toBe(true)
  })
})
