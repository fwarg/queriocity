/** Preferred-hour scheduling for daily monitors.
 *
 *  The bug this guards: the local hour was converted to UTC by subtracting `actualHour - hour`
 *  straight, which is a difference between two clock readings. When the timezone offset pushes the
 *  hour past midnight that difference reads as ~±24 rather than the couple of hours it is, and the
 *  run was scheduled a full day late — measured at hour=23 in UTC+2 landing on the following day,
 *  while `candidate >= earliest` accepted it without complaint. */

import './test-support/test-env.ts'
import { describe, test, expect } from 'bun:test'
import { computeNextRunAt } from './monitor-runner.ts'

const NOW = new Date('2026-08-12T10:00:00Z')   // 12:00 in Stockholm, 22:00 in Auckland
const DAILY = 1440

const localOf = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(d)
const hourOf = (d: Date, tz: string) =>
  +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, hourCycle: 'h23' }).format(d)

describe('computeNextRunAt with a preferred hour', () => {
  /** Every hour of the day, in zones east and west of UTC and one that is half-offset. */
  test('lands on the requested local hour, whatever the offset', () => {
    for (const tz of ['Europe/Stockholm', 'Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
      for (let hour = 0; hour < 24; hour++) {
        const next = computeNextRunAt(DAILY, hour, tz, NOW, true)
        expect({ tz, hour, got: hourOf(next, tz) }).toEqual({ tz, hour, got: hour })
      }
    }
  })

  test('schedules the late hours today rather than tomorrow', () => {
    // 22:00 and 23:00 Stockholm are still ahead of 12:00 Stockholm, so they belong to the same day.
    // These are the two that crossed midnight in the arithmetic and slipped a day.
    expect(localOf(computeNextRunAt(DAILY, 22, 'Europe/Stockholm', NOW, true), 'Europe/Stockholm'))
      .toBe('2026-08-12 22:00')
    expect(localOf(computeNextRunAt(DAILY, 23, 'Europe/Stockholm', NOW, true), 'Europe/Stockholm'))
      .toBe('2026-08-12 23:00')
  })

  test('never schedules in the past', () => {
    for (const tz of ['Europe/Stockholm', 'Pacific/Auckland', 'America/Los_Angeles']) {
      for (let hour = 0; hour < 24; hour++) {
        expect(computeNextRunAt(DAILY, hour, tz, NOW, true).getTime()).toBeGreaterThanOrEqual(NOW.getTime())
      }
    }
  })

  test('ignores the preferred hour below a daily interval, where snapping would skip runs', () => {
    const next = computeNextRunAt(60, 23, 'Europe/Stockholm', NOW, true)
    expect(next.getTime()).toBe(NOW.getTime() + 60 * 60_000)
  })
})
