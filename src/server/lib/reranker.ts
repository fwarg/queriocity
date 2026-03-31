const RERANK_URL = process.env.RERANK_BASE_URL ?? process.env.BASE_URL
const RERANK_MODEL = process.env.RERANK_MODEL
const RERANK_TOP_N = parseInt(process.env.RERANK_TOP_N ?? '15', 10)

export const rerankEnabled = !!RERANK_MODEL

/**
 * Reranks documents by relevance to query. Returns indices sorted best-first.
 * Falls back to identity order if reranker is not configured or call fails.
 */
export async function rerank(query: string, documents: string[], topN = RERANK_TOP_N): Promise<number[]> {
  if (!rerankEnabled || documents.length === 0) return documents.map((_, i) => i)
  try {
    const res = await fetch(`${RERANK_URL}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer none' },
      body: JSON.stringify({ model: RERANK_MODEL, query, documents }),
    })
    if (!res.ok) throw new Error(`reranker HTTP ${res.status}`)
    const data = await res.json() as { results: Array<{ index: number; relevance_score: number }> }
    return data.results
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, topN)
      .map(r => r.index)
  } catch (e) {
    console.warn('  [reranker] failed, using original order:', e)
    return documents.map((_, i) => i)
  }
}
