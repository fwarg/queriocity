// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect } from 'bun:test'
import { getNumberSetting, setAppSetting } from './db.ts'

describe('getNumberSetting', () => {
  test('reads a stored number, including 0 and negatives', async () => {
    for (const [stored, expected] of [['0', 0], ['-1', -1], ['0.35', 0.35], [' 12 ', 12]] as const) {
      await setAppSetting('test_number', stored)
      expect(await getNumberSetting('test_number', 99)).toBe(expected)
    }
  })

  test('falls back when unset, empty or not a number', async () => {
    expect(await getNumberSetting('test_never_set', 7)).toBe(7)
    for (const stored of ['', 'abc', 'NaN', 'Infinity']) {
      await setAppSetting('test_number', stored)
      expect(await getNumberSetting('test_number', 7)).toBe(7)
    }
  })
})
