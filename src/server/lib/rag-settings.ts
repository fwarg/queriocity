import { getAppSetting } from './db.ts'

/** How many nearest chunks every vector search asks for.
 *
 *  One number for all five retrieval paths — space memory RAG, space file RAG, chat-file RAG for
 *  non-space chats, the `uploads_search` tool and the `search_space_history` tool. They used to
 *  carry four different depths: 5 as a function default that every real caller overrode with 15, 15
 *  hardcoded in a SQL literal, and 8 for history search. So the declared defaults described nothing
 *  that actually ran, and changing retrieval depth meant editing three files.
 *
 *  `rerank_top_n` prunes whatever comes back, so this is the *candidate* count and that is the
 *  ceiling on what reranking can consider.
 *
 *  Lives in its own module rather than in memory.ts because uploads-search.ts needs it too, and
 *  memory.ts already imports uploads-search.ts — the other direction would be a cycle.
 *
 *  Read per call: it is an Admin setting and takes effect without a restart. */
export const ragTopK = async (): Promise<number> =>
  parseInt(await getAppSetting('rag_top_k', '15'), 10) || 15

/** Minimum cross-encoder relevance score a resource/document chunk must clear to be injected at
 *  all, instead of always filling out the top-K regardless of how weak the match is. `0` (default)
 *  disables the floor. Only meaningful when reranking is enabled — there is no model-agnostic
 *  equivalent over raw vector distance, so callers without a reranker are unaffected. */
export const ragMinRelevance = async (): Promise<number> =>
  parseFloat(await getAppSetting('rag_min_relevance', '0')) || 0
