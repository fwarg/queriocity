import { getNumberSetting } from './db.ts'
import { DEFAULT_MEMORY_TOKEN_BUDGET } from './llm.ts'

/** Token budget for a space's memory block. */
export const memoryTokenBudget = (): Promise<number> =>
  getNumberSetting('memory_token_budget', DEFAULT_MEMORY_TOKEN_BUDGET)

/** Token budget for resource excerpts injected alongside a space's memory (and picked collections). */
export const spaceRagBudget = (): Promise<number> =>
  getNumberSetting('space_rag_budget', 500)

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
 *  Lives in its own module rather than in memory/ because uploads-search.ts needs it too, and
 *  memory/ already imports uploads-search.ts — the other direction would be a cycle.
 *
 *  Read per call: it is an Admin setting and takes effect without a restart. */
export const ragTopK = (): Promise<number> =>
  getNumberSetting('rag_top_k', 15)

/** Minimum cross-encoder relevance score a resource/document chunk must clear to be injected at
 *  all, instead of always filling out the top-K regardless of how weak the match is. `0` (default)
 *  disables the floor. Only meaningful when reranking is enabled — there is no model-agnostic
 *  equivalent over raw vector distance, so callers without a reranker are unaffected. */
export const ragMinRelevance = (): Promise<number> =>
  getNumberSetting('rag_min_relevance', 0)

/** Reranker relevance (0–1) below which an Explore answer takes a passage or part as unrelated.
 *  Lower than the retrieval floor: question-to-passage scores run low — relevant passages scored
 *  0.05–0.86 in real runs, unrelated ones 0.035 or less. */
export const DEFAULT_EXPLORE_MIN_RELEVANCE = 0.05
export const exploreMinRelevance = (): Promise<number> =>
  getNumberSetting('collection_explore_min_relevance', DEFAULT_EXPLORE_MIN_RELEVANCE)

/** Cosine similarity a resource must reach to be offered as "similar content". What counts as
 *  similar depends on the embedding model, hence a setting; the scores are logged to calibrate it. */
export const DEFAULT_RELATED_MIN_SIMILARITY = 0.5
export const relatedMinSimilarity = (): Promise<number> =>
  getNumberSetting('related_min_similarity', DEFAULT_RELATED_MIN_SIMILARITY)

/** Reranker relevance (0–1) a candidate must reach when a reranker judges "similar content". 0.5
 *  is where a logit-scoring cross-encoder's own verdict turns from irrelevant to relevant. */
export const DEFAULT_RELATED_MIN_RELEVANCE = 0.5
export const relatedMinRelevance = (): Promise<number> =>
  getNumberSetting('related_min_relevance', DEFAULT_RELATED_MIN_RELEVANCE)

/** Token budget for the "Notes first" block. Larger than the space RAG budget: there the notes are
 *  one source among several, here they are what the answer is meant to rest on. */
export const DEFAULT_NOTES_RAG_BUDGET = 1500
export const notesRagBudget = (): Promise<number> =>
  getNumberSetting('notes_rag_budget', DEFAULT_NOTES_RAG_BUDGET)

/** Average cosine similarity at which the topic map stops merging notes into a topic. Depends on the
 *  embedding model like the related-content floor; Admin → Similarity shows the values to pick from. */
export const DEFAULT_TOPIC_MIN_SIMILARITY = 0.6
export const topicMinSimilarity = (): Promise<number> =>
  getNumberSetting('topic_min_similarity', DEFAULT_TOPIC_MIN_SIMILARITY)

/** Cosine similarity at which a topic is offered as an existing tag, and the lower one at which a new
 *  topic is placed beside its nearest tag. Short phrases embed noisily and the scale depends on the
 *  model; each match and placement is logged as a `[tags]` line to calibrate them. */
export const DEFAULT_TAG_MATCH_SIMILARITY = 0.8
export const DEFAULT_TAG_PLACE_SIMILARITY = 0.6
export const tagMatchSimilarity = (): Promise<number> =>
  getNumberSetting('tag_match_similarity', DEFAULT_TAG_MATCH_SIMILARITY)
export const tagPlaceSimilarity = (): Promise<number> =>
  getNumberSetting('tag_place_similarity', DEFAULT_TAG_PLACE_SIMILARITY)
