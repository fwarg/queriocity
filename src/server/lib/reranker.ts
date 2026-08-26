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

/** Sorts best-first, drops anything below `minScore`, then caps at `topN` — split out from
 *  `rerank` so the ordering/filtering logic is testable without the `rerankEnabled` gate or a
 *  network call. `minScore` drops results below a relevance floor before the cap — used by
 *  document/resource retrieval to keep a barely-related file from being injected just to fill
 *  top-K. Omitted by callers (web-source and space-memory reranking) that want today's
 *  slice-only behavior, since it has no model-agnostic equivalent once the reranker is disabled. */
export function selectRerankedIndices(
  results: Array<{ index: number; relevance_score: number }>,
  topN: number,
  minScore?: number,
): number[] {
  return results
    .slice()
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .filter(r => minScore == null || r.relevance_score >= minScore)
    .slice(0, topN)
    .map(r => r.index)
}

export async function rerank(query: string, documents: string[], topN?: number, minScore?: number): Promise<number[]> {
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
    return selectRerankedIndices(data.results, n, minScore)
  } catch (e) {
    console.warn('  [reranker] failed, using original order:', e)
    return documents.map((_, i) => i)
  }
}
