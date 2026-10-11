import { describe, test, expect } from 'bun:test'
import { toTheme } from './theme.ts'

describe('toTheme', () => {
  test('accepts the known themes only', () => {
    expect(toTheme('eink')).toBe('eink')
    expect(toTheme('light')).toBe('light')
    expect(toTheme('sepia')).toBeUndefined()
    expect(toTheme(null)).toBeUndefined()
  })
})
