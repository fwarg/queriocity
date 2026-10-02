/** Persistent per-provider call counts by UTC month, enforcing the policy's monthly quotas.
 *
 *  Synchronous on the bun:sqlite handle on purpose: check and increment run with no await between,
 *  so parallel searches in one process cannot together overshoot a quota. */

import { sqlite } from '../db.ts'

/** The UTC calendar month a call counts towards, as `YYYY-MM`. */
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7)

const countFor = (provider: string, month: string): number =>
  (sqlite.query('SELECT count FROM search_usage WHERE provider = ? AND month = ?').get(provider, month) as { count: number } | null)?.count ?? 0

/** True when the provider is under `quota` this month (or `quota` is 0, unlimited); records the call. */
export function takeQuota(provider: string, quota: number, now = new Date()): boolean {
  const month = monthKey(now)
  if (quota > 0 && countFor(provider, month) >= quota) return false
  sqlite.run(
    'INSERT INTO search_usage (provider, month, count) VALUES (?, ?, 1) ON CONFLICT(provider, month) DO UPDATE SET count = count + 1',
    [provider, month],
  )
  return true
}

/** True when the provider could still make a call this month. */
export function hasQuota(provider: string, quota: number): boolean {
  return quota <= 0 || countFor(provider, monthKey()) < quota
}

/** Calls per provider in the current month. */
export function monthlyUsage(): Record<string, number> {
  const rows = sqlite.query('SELECT provider, count FROM search_usage WHERE month = ?').all(monthKey()) as Array<{ provider: string; count: number }>
  return Object.fromEntries(rows.map(r => [r.provider, r.count]))
}
