import { describe, test, expect } from 'bun:test'
import { parseUserSettings } from './user-settings.ts'

describe('parseUserSettings', () => {
  test('keeps every valid field when one is invalid, and drops keys the schema no longer knows', () => {
    expect(parseUserSettings({ theme: 'no-such-theme', fontSize: 16, useThinking: true, thinking: 'balanced' }))
      .toEqual({ fontSize: 16, useThinking: true })
  })

  test('reads anything that is not an object as no settings', () => {
    for (const raw of [null, 'x', 42, undefined]) expect(parseUserSettings(raw)).toEqual({})
  })
})
