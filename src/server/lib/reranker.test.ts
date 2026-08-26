import { describe, test, expect } from 'bun:test'
import { selectRerankedIndices, truncateForRerank } from './reranker.ts'

describe('selectRerankedIndices', () => {
  const results = [
    { index: 0, relevance_score: 0.9 },
    { index: 1, relevance_score: 0.4 },
    { index: 2, relevance_score: 0.1 },
  ]

  test('drops results below the floor before applying topN', () => {
    // Sorted best-first, then floored: index 2 (score 0.1) is cut, 0 and 1 survive.
    expect(selectRerankedIndices(results, 10, 0.3)).toEqual([0, 1])
  })

  test('omitting minScore keeps today\'s slice-only behavior', () => {
    expect(selectRerankedIndices(results, 10)).toEqual([0, 1, 2])
  })

  test('minScore of 0 filters nothing', () => {
    expect(selectRerankedIndices(results, 10, 0)).toEqual([0, 1, 2])
  })

  test('topN still caps after the floor is applied', () => {
    expect(selectRerankedIndices(results, 1, 0)).toEqual([0])
  })
})

describe('truncateForRerank', () => {
  test('leaves short documents untouched', () => {
    const { truncated, numTruncated } = truncateForRerank(['short', 'also short'], 100)
    expect(truncated).toEqual(['short', 'also short'])
    expect(numTruncated).toBe(0)
  })

  test('caps documents over the limit and counts them', () => {
    const long = 'x'.repeat(2000)
    const { truncated, numTruncated } = truncateForRerank(['short', long], 1200)
    expect(truncated[0]).toBe('short')
    expect(truncated[1]).toHaveLength(1200)
    expect(numTruncated).toBe(1)
  })
})
