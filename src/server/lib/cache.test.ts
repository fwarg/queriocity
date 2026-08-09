import { describe, test, expect } from 'bun:test'
import { cacheKey, getCached, setCached } from './cache.ts'

describe('cache', () => {
  test('cacheKey is deterministic', () => {
    expect(cacheKey('q', 'fast', 'u1')).toBe(cacheKey('q', 'fast', 'u1'))
  })

  test('cacheKey differs by query and mode', () => {
    expect(cacheKey('a', 'fast', 'u1')).not.toBe(cacheKey('b', 'fast', 'u1'))
    expect(cacheKey('a', 'fast', 'u1')).not.toBe(cacheKey('a', 'balanced', 'u1'))
  })

  test('cacheKey differs by scope, so an answer cannot cross users or spaces', () => {
    expect(cacheKey('a', 'fast', 'u1')).not.toBe(cacheKey('a', 'fast', 'u2'))
    expect(cacheKey('a', 'fast', 'u1|space-1')).not.toBe(cacheKey('a', 'fast', 'u1|space-2'))
  })

  // The bug this guards: keyed on the last message alone, two unrelated conversations that both
  // end in "Is it officially shut down?" collided and the second was served the first's answer.
  test('cacheKey differs by conversation history', () => {
    const followUp = 'Is it officially shut down?'
    const aboutDoge = [{ role: 'user', content: 'What happened to DOGE?' }, { role: 'assistant', content: 'It was wound down.' }]
    const aboutReactor = [{ role: 'user', content: 'Tell me about the Barsebäck reactor' }, { role: 'assistant', content: 'It stopped producing in 2005.' }]
    expect(cacheKey(followUp, 'balanced', 'u1', aboutDoge)).not.toBe(cacheKey(followUp, 'balanced', 'u1', aboutReactor))
  })

  test('cacheKey is stable for the same history', () => {
    const history = [{ role: 'user', content: 'earlier question' }]
    expect(cacheKey('q', 'balanced', 'u1', history)).toBe(cacheKey('q', 'balanced', 'u1', history))
  })

  test('cacheKey ignores history beyond the retained turns', () => {
    const recent = Array.from({ length: 4 }, (_, i) => ({ role: 'user', content: `recent ${i}` }))
    expect(cacheKey('q', 'balanced', 'u1', [{ role: 'user', content: 'ancient' }, ...recent]))
      .toBe(cacheKey('q', 'balanced', 'u1', recent))
  })

  test('getCached returns null for unknown key', () => {
    expect(getCached('no-such-key')).toBeNull()
  })

  test('setCached then getCached returns the value', () => {
    const key = cacheKey('test-query', 'balanced', 'u1')
    setCached(key, { answer: 42 })
    const result = getCached<{ answer: number }>(key)
    expect(result).not.toBeNull()
    expect(result!.answer).toBe(42)
  })

  test('getCached returns a fresh value immediately after set', () => {
    const key = cacheKey('fresh', 'fast', 'u1')
    setCached(key, 'result')
    expect(getCached<string>(key)).toBe('result')
  })
})
