import { getAppSetting } from './db.ts'

const RERANK_URL = process.env.RERANK_BASE_URL ?? process.env.BASE_URL
const RERANK_MODEL = process.env.RERANK_MODEL

export const rerankEnabled = !!RERANK_MODEL
// Reranking is an optimisation, and the caller already falls back to the original order,
// so a slow reranker should give up quickly rather than delay the answer.
const RERANK_TIMEOUT_MS = parseInt(process.env.RERANK_TIMEOUT_MS ?? '30000', 10)

/**
 * Reranks documents by relevance to query. Returns indices sorted best-first.
 * Falls back to identity order if reranker is not configured or call fails.
 */
/** Orders search results by relevance, best-first, and prunes to the configured `rerank_top_n`.
 *  Identity when no reranker is configured, so callers need no branch of their own. Pruning is
 *  as much the point as ordering: everything kept here is paid for in the prompt downstream. */
export async function rerankSearchResults<T extends { content: string }>(query: string, results: T[]): Promise<T[]> {
  if (!rerankEnabled || results.length === 0 || !query) return results
  const t = performance.now()
  const indices = await rerank(query, results.map(r => r.content))
  const ranked = indices.map(i => results[i]).filter(Boolean)
  console.log(`  [reranker] ${results.length} → ${ranked.length} sources in ${Math.round(performance.now() - t)}ms`)
  return ranked
}

export async function rerank(query: string, documents: string[], topN?: number): Promise<number[]> {
  if (!rerankEnabled || documents.length === 0) return documents.map((_, i) => i)
  const n = topN ?? parseInt(await getAppSetting('rerank_top_n', '15'), 10)
  try {
    const res = await fetch(`${RERANK_URL}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer none' },
      body: JSON.stringify({ model: RERANK_MODEL, query, documents }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`reranker HTTP ${res.status}`)
    const data = await res.json() as { results: Array<{ index: number; relevance_score: number }> }
    return data.results
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, n)
      .map(r => r.index)
  } catch (e) {
    console.warn('  [reranker] failed, using original order:', e)
    return documents.map((_, i) => i)
  }
}
