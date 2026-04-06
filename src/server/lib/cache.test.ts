import { describe, test, expect } from 'bun:test'
import { cacheKey, getCached, setCached } from './cache.ts'

describe('cache', () => {
  test('cacheKey is deterministic', () => {
    expect(cacheKey('q', 'fast')).toBe(cacheKey('q', 'fast'))
  })

  test('cacheKey differs by query and mode', () => {
    expect(cacheKey('a', 'fast')).not.toBe(cacheKey('b', 'fast'))
    expect(cacheKey('a', 'fast')).not.toBe(cacheKey('a', 'balanced'))
  })

  test('getCached returns null for unknown key', () => {
    expect(getCached('no-such-key')).toBeNull()
  })

  test('setCached then getCached returns the value', () => {
    const key = cacheKey('test-query', 'balanced')
    setCached(key, { answer: 42 })
    const result = getCached<{ answer: number }>(key)
    expect(result).not.toBeNull()
    expect(result!.answer).toBe(42)
  })

  test('getCached returns a fresh value immediately after set', () => {
    const key = cacheKey('fresh', 'fast')
    setCached(key, 'result')
    expect(getCached<string>(key)).toBe('result')
  })
})
