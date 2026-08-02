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
