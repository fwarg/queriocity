/** Per-user cloud LLM access and metered spend, by provider and UTC month.
 *
 *  Synchronous on the bun:sqlite handle, as search/usage.ts is: a usage row is upserted straight
 *  from the model stream's finish part, with no await between read and write. */

import { sqlite } from './db.ts'
import { monthKey } from './search/usage.ts'
import type { TokenUsage } from './llm.ts'
import { lookupGeneration } from './llm-metering.ts'
import type { CloudModel, CloudProvider, LlmAccess, UsageRow } from '../../shared/llm-catalogue.ts'

/** Cost of one call from the catalogue's per-million prices. */
export const costOf = (u: TokenUsage, model: Pick<CloudModel, 'priceIn' | 'priceOut'>): number =>
  (u.inputTokens * model.priceIn + u.outputTokens * model.priceOut) / 1_000_000

/** Adds a call to the month's row. `requests` is 0 for a correction to a call already counted. */
export function recordLlmUsage(userId: string, providerId: string, u: TokenUsage, cost: number, now = new Date(), requests = 1): void {
  sqlite.run(
    `INSERT INTO llm_usage (user_id, provider_id, month, cost, input_tokens, output_tokens, requests)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider_id, month) DO UPDATE SET
       cost = cost + excluded.cost,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       requests = requests + excluded.requests`,
    [userId, providerId, monthKey(now), cost, u.inputTokens, u.outputTokens, requests],
  )
}

/** Retry schedule for a generation lookup: the stats appear some time after a call ends, how long
 *  is not documented. */
export const GENERATION_LOOKUP_DELAYS_MS = [3_000, 15_000, 60_000]

/** Replaces a stopped call's estimate with what the provider says it cost, once it says. The
 *  estimate stays as recorded and the difference is added, so the month's totals end up exact. */
export async function reconcileGeneration(
  { userId, providerId, endpoint, generationId, estimate, estimatedCost, onCorrection }: {
    userId: string
    providerId: string
    endpoint: { baseURL: string; apiKey?: string }
    generationId: string
    estimate: TokenUsage
    estimatedCost: number
    onCorrection?: (delta: number) => void
  },
  delays = GENERATION_LOOKUP_DELAYS_MS,
): Promise<boolean> {
  const month = new Date()
  for (const delay of delays) {
    await Bun.sleep(delay)
    const stats = await lookupGeneration(endpoint.baseURL, endpoint.apiKey, generationId)
    if (!stats) continue
    const correction = { inputTokens: stats.inputTokens - estimate.inputTokens, outputTokens: stats.outputTokens - estimate.outputTokens }
    // Counted in the month of the call, even if the lookup lands after midnight on the 1st.
    recordLlmUsage(userId, providerId, correction, stats.totalCost - estimatedCost, month, 0)
    onCorrection?.(stats.totalCost - estimatedCost)
    console.log(`  [llm] ${generationId}: stopped call cost ${stats.totalCost} (estimated ${estimatedCost.toPrecision(3)})`)
    return true
  }
  console.warn(`  [llm] ${generationId}: no cost reported after ${delays.length} lookups — the estimate stands`)
  return false
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
export interface MeterOptions {
  /** Sees each call and its cost, e.g. to total the answer's cost and learn its hosting provider. */
  onCall?: (u: TokenUsage, cost: number) => void
  /** Where to look up a stopped call's real cost by generation id. */
  endpoint?: { baseURL: string; apiKey?: string }
  /** The difference once a stopped call's real cost is known, to correct the answer's own figure. */
  onCorrection?: (delta: number) => void
}

export const meteredUsage = (
  userId: string,
  model: CloudModel,
  provider: Pick<CloudProvider, 'reportedCostUnit' | 'currency'>,
  { onCall, endpoint, onCorrection }: MeterOptions = {},
) => (u: TokenUsage) => {
  const cost = callCost(u, model, provider.reportedCostUnit)
  recordLlmUsage(userId, model.providerId, u, cost)
  onCall?.(u, cost)
  // A stopped call was recorded as an estimate. Where the provider can say what it cost — by
  // generation id, in USD — that is looked up in the background.
  if (u.estimated && u.generationId && endpoint && provider.currency === 'USD') {
    reconcileGeneration({ userId, providerId: model.providerId, endpoint, generationId: u.generationId, estimate: u, estimatedCost: cost, onCorrection })
      .catch(e => console.error('  [llm] generation lookup failed:', e))
  }
}

/** Adds to the cost stored with an answer, once a stopped call's real cost is known. */
export function addAnswerCost(messageId: string, delta: number): void {
  sqlite.run(
    `UPDATE messages SET model = json_set(model, '$.cost', COALESCE(json_extract(model, '$.cost'), 0) + ?)
     WHERE id = ? AND json_extract(model, '$.cost') IS NOT NULL`,
    [delta, messageId],
  )
}
