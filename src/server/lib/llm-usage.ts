/** Per-user cloud LLM access and metered spend, by provider and UTC month.
 *
 *  Synchronous on the bun:sqlite handle, as search/usage.ts is: a usage row is upserted straight
 *  from the model stream's finish part, with no await between read and write. */

import { sqlite } from './db.ts'
import { monthKey } from './search/usage.ts'
import type { TokenUsage } from './llm.ts'
import type { CloudModel, CloudProvider, LlmAccess, UsageRow } from '../../shared/llm-catalogue.ts'

/** Cost of one call from the catalogue's per-million prices. */
export const costOf = (u: TokenUsage, model: Pick<CloudModel, 'priceIn' | 'priceOut'>): number =>
  (u.inputTokens * model.priceIn + u.outputTokens * model.priceOut) / 1_000_000

export function recordLlmUsage(userId: string, providerId: string, u: TokenUsage, cost: number, now = new Date()): void {
  sqlite.run(
    `INSERT INTO llm_usage (user_id, provider_id, month, cost, input_tokens, output_tokens, requests)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, provider_id, month) DO UPDATE SET
       cost = cost + excluded.cost,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       requests = requests + 1`,
    [userId, providerId, monthKey(now), cost, u.inputTokens, u.outputTokens],
  )
}

/** A user's spend with a provider this month. */
export const userSpend = (userId: string, providerId: string): number =>
  (sqlite.query('SELECT cost FROM llm_usage WHERE user_id = ? AND provider_id = ? AND month = ?')
    .get(userId, providerId, monthKey()) as { cost: number } | null)?.cost ?? 0

/** All users' spend with a provider this month, for its global cap. */
export const providerSpend = (providerId: string): number =>
  (sqlite.query('SELECT SUM(cost) AS cost FROM llm_usage WHERE provider_id = ? AND month = ?')
    .get(providerId, monthKey()) as { cost: number | null } | null)?.cost ?? 0

/** Every usage row of this month, for the admin view. */
export function monthlyLlmUsage(): UsageRow[] {
  return sqlite.query(
    `SELECT user_id AS userId, provider_id AS providerId, cost, input_tokens AS inputTokens,
            output_tokens AS outputTokens, requests
     FROM llm_usage WHERE month = ? ORDER BY provider_id, cost DESC`,
  ).all(monthKey()) as UsageRow[]
}

export function getLlmAccess(userId: string): LlmAccess {
  const user = sqlite.query('SELECT cloud_enabled AS enabled FROM users WHERE id = ?').get(userId) as { enabled: number } | null
  const rows = sqlite.query('SELECT provider_id AS providerId, monthly_budget AS budget FROM user_llm_access WHERE user_id = ?')
    .all(userId) as Array<{ providerId: string; budget: number }>
  return { cloudEnabled: !!user?.enabled, budgets: Object.fromEntries(rows.map(r => [r.providerId, r.budget])) }
}

/** Replaces a user's access in one transaction, so a half-applied change is never visible. */
export const setLlmAccess = sqlite.transaction((userId: string, access: LlmAccess) => {
  sqlite.run('UPDATE users SET cloud_enabled = ? WHERE id = ?', [access.cloudEnabled ? 1 : 0, userId])
  sqlite.run('DELETE FROM user_llm_access WHERE user_id = ?', [userId])
  for (const [providerId, budget] of Object.entries(access.budgets)) {
    sqlite.run('INSERT INTO user_llm_access (user_id, provider_id, monthly_budget) VALUES (?, ?, ?)', [userId, providerId, budget])
  }
})

/** Access for every user that has any, keyed by user id, for the admin users list. */
export function allLlmAccess(): Record<string, LlmAccess> {
  const out: Record<string, LlmAccess> = {}
  const enabled = sqlite.query('SELECT id FROM users WHERE cloud_enabled = 1').all() as Array<{ id: string }>
  for (const { id } of enabled) out[id] = { cloudEnabled: true, budgets: {} }
  const rows = sqlite.query('SELECT user_id AS userId, provider_id AS providerId, monthly_budget AS budget FROM user_llm_access')
    .all() as Array<{ userId: string; providerId: string; budget: number }>
  for (const r of rows) (out[r.userId] ??= { cloudEnabled: false, budgets: {} }).budgets[r.providerId] = r.budget
  return out
}

/** A call's cost in the provider's currency: its own figure when it reports one and the catalogue
 *  says what that figure's unit is worth, else the estimate from the catalogue prices. */
export const callCost = (u: TokenUsage, model: Pick<CloudModel, 'priceIn' | 'priceOut'>, reportedCostUnit?: number): number =>
  reportedCostUnit && u.reportedCost !== undefined ? u.reportedCost * reportedCostUnit : costOf(u, model)

/** Hooks a catalogue model's calls up to the meter: every call is priced and recorded; `onCall`
 *  sees each call and its cost too, e.g. to total the answer's cost and learn its hosting provider. */
export const meteredUsage = (userId: string, model: CloudModel, provider: Pick<CloudProvider, 'reportedCostUnit'>, onCall?: (u: TokenUsage, cost: number) => void) =>
  (u: TokenUsage) => {
    const cost = callCost(u, model, provider.reportedCostUnit)
    recordLlmUsage(userId, model.providerId, u, cost)
    onCall?.(u, cost)
  }
