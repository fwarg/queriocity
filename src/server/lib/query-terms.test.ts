import { describe, test, expect } from 'bun:test'
import { queryTerms, querySimilarity, hasMangledToken, QUERY_DUPLICATE_THRESHOLD } from './query-terms.ts'

describe('queryTerms', () => {
  test('drops punctuation, case and stopwords', () => {
    expect([...queryTerms('What happened to DOGE, the department?')].sort())
      .toEqual(['department', 'doge'])
  })

  test('keeps digits, so a year still separates two queries', () => {
    expect(queryTerms('iPhone 2026').has('2026')).toBe(true)
  })
})

describe('querySimilarity', () => {
  test('identical term sets score 1', () => {
    expect(querySimilarity(queryTerms('DOGE department status'), queryTerms('status DOGE department'))).toBe(1)
  })

  test('unrelated queries score 0', () => {
    expect(querySimilarity(queryTerms('DOGE department'), queryTerms('iPhone battery'))).toBe(0)
  })

  test('an empty side scores 0 rather than dividing by zero', () => {
    expect(querySimilarity(queryTerms('the of in'), queryTerms('DOGE'))).toBe(0)
  })

  test('a rephrasing of the same search reaches the duplicate threshold', () => {
    const a = queryTerms('DOGE department government efficiency status 2026')
    const b = queryTerms('status of the DOGE department government efficiency 2026')
    expect(querySimilarity(a, b)).toBeGreaterThanOrEqual(QUERY_DUPLICATE_THRESHOLD)
  })

  test('a genuine refinement stays below the threshold, so it is not suppressed', () => {
    const a = queryTerms('DOGE department status')
    const b = queryTerms('DOGE department budget cuts congressional testimony')
    expect(querySimilarity(a, b)).toBeLessThan(QUERY_DUPLICATE_THRESHOLD)
  })
})

describe('hasMangledToken', () => {
  // The production failure: "DOGE" came back from the small model as "do ge".
  test('flags a name the model split across a space', () => {
    expect(hasMangledToken('do ge official shutdown 2026', 'What happened to DOGE?')).toBe(true)
  })

  test('leaves an intact query alone', () => {
    expect(hasMangledToken('DOGE official shutdown 2026', 'What happened to DOGE?')).toBe(false)
  })

  test('does not flag a compound whose halves are words in their own right', () => {
    // "health" and "care" both appear in the reference, so this is a rewrite, not a mangling.
    expect(hasMangledToken('health care costs', 'healthcare and health care policy')).toBe(false)
  })

  test('does not flag words absent from the reference entirely', () => {
    expect(hasMangledToken('iPhone battery life', 'What happened to DOGE?')).toBe(false)
  })
})
