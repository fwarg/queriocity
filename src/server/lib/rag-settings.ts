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

/** Cosine similarity a resource must reach to be offered as "similar content". What counts as
 *  similar depends on the embedding model, hence a setting; the scores are logged to calibrate it. */
export const DEFAULT_RELATED_MIN_SIMILARITY = 0.5
export const relatedMinSimilarity = async (): Promise<number> => {
  const v = parseFloat(await getAppSetting('related_min_similarity', String(DEFAULT_RELATED_MIN_SIMILARITY)))
  return Number.isNaN(v) ? DEFAULT_RELATED_MIN_SIMILARITY : v
}

/** Reranker relevance (0–1) a candidate must reach when a reranker judges "similar content". 0.5
 *  is where a logit-scoring cross-encoder's own verdict turns from irrelevant to relevant. */
export const DEFAULT_RELATED_MIN_RELEVANCE = 0.5
export const relatedMinRelevance = async (): Promise<number> => {
  const v = parseFloat(await getAppSetting('related_min_relevance', String(DEFAULT_RELATED_MIN_RELEVANCE)))
  return Number.isNaN(v) ? DEFAULT_RELATED_MIN_RELEVANCE : v
}

/** Token budget for the "Notes first" block. Larger than the space RAG budget: there the notes are
 *  one source among several, here they are what the answer is meant to rest on. */
export const DEFAULT_NOTES_RAG_BUDGET = 1500
export const notesRagBudget = async (): Promise<number> => {
  const v = parseInt(await getAppSetting('notes_rag_budget', String(DEFAULT_NOTES_RAG_BUDGET)), 10)
  return Number.isNaN(v) ? DEFAULT_NOTES_RAG_BUDGET : v
}

/** Average cosine similarity at which the topic map stops merging notes into a topic. Depends on the
 *  embedding model like the related-content floor; Admin → Similarity shows the values to pick from. */
export const DEFAULT_TOPIC_MIN_SIMILARITY = 0.6
export const topicMinSimilarity = async (): Promise<number> => {
  const v = parseFloat(await getAppSetting('topic_min_similarity', String(DEFAULT_TOPIC_MIN_SIMILARITY)))
  return Number.isNaN(v) ? DEFAULT_TOPIC_MIN_SIMILARITY : v
}
