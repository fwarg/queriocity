import { and, eq, inArray } from 'drizzle-orm'
import { db, spaces } from '../db.ts'
import { ragTopK } from '../rag-settings.ts'
import { searchSpaceFiles, type ChunkResult } from './uploads-search.ts'

/** Retrieval over collections — groupings that hold resources and nothing else.
 *
 *  A collection is a `spaces` row, so `searchSpaceFiles` works on its id verbatim and there is no
 *  second retrieval path to keep correct. That reuse is the whole reason collections are a *kind* of
 *  space rather than a table of their own. */

/** The collections among these ids that this user owns, in the order given.
 *
 *  Filtering rather than erroring on an unknown id: the selection lives in the chat input, so a
 *  collection deleted in another tab would otherwise fail the turn instead of the request simply
 *  proceeding without it. */
export async function ownedCollectionIds(ids: string[], userId: string): Promise<string[]> {
  if (!ids.length) return []
  const rows = await db.select({ id: spaces.id }).from(spaces).where(and(
    eq(spaces.userId, userId),
    eq(spaces.kind, 'collection'),
    inArray(spaces.id, ids),
  ))
  const owned = new Set(rows.map(r => r.id))
  return ids.filter(id => owned.has(id))
}

/** Merged excerpts from several collections, nearest first.
 *
 *  One query per collection rather than one query over all of them: `space_files` is a join table,
 *  and sqlite-vec applies `k` before joined-table filters — the trap documented on
 *  `searchSpaceFiles`. Asking per collection keeps `k` meaning "k nearest within this collection".
 *
 *  Reranking is skipped per call and left to the caller, so chunks from different collections are
 *  scored against each other rather than only against their own. */
export async function searchCollections(
  collectionIds: string[],
  query: string,
  embedding: number[],
  limit?: number,
): Promise<ChunkResult[]> {
  if (!collectionIds.length) return []
  const topK = limit ?? await ragTopK()

  const perCollection = await Promise.all(
    collectionIds.map(id => searchSpaceFiles(id, query, embedding, topK, true)),
  )

  // A resource tagged to two selected collections comes back from both, and injecting the same
  // excerpt twice spends the budget on nothing and reads to the model as corroboration.
  const seen = new Set<string>()
  return perCollection.flat()
    .filter(chunk => !seen.has(chunk.chunkId) && seen.add(chunk.chunkId))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topK)
}
