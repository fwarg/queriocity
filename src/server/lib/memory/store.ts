/** Space-memory rows and their embeddings. */

import { db, spaceMemories, sqlite } from '../db.ts'
import { eq, desc } from 'drizzle-orm'
import { embedText, embedTexts } from '../embeddings.ts'
import { type MemorySource } from './sources.ts'

export interface SpaceMemory {
  id: string
  spaceId: string
  content: string
  source: 'tool' | 'extraction' | 'manual' | 'compact'
  sessionId: string | null
  alwaysKeep: boolean
  /** Web sources the memory came from — panel/verify metadata, never injected into the prompt. */
  sources: MemorySource[] | null
  /** Unix seconds the sources last confirmed the memory; null when unverified. */
  checkedAt: number | null
  createdAt: Date
  updatedAt: Date
}

/** Load all memories for a space, newest first. */
export async function getSpaceMemories(spaceId: string) {
  return db.select().from(spaceMemories)
    .where(eq(spaceMemories.spaceId, spaceId))
    .orderBy(desc(spaceMemories.createdAt))
}

/** Store/replace the vector for one memory. Never throws: an embedding failure must not lose the
 *  memory itself, and `backfillMemoryEmbeddings` retries on the next read. */
export async function embedMemory(memoryId: string, content: string): Promise<void> {
  try {
    const embedding = await embedText(content, 'document')
    sqlite.run('DELETE FROM memory_embeddings WHERE memory_id = ?', [memoryId])
    sqlite.run('INSERT INTO memory_embeddings(memory_id, embedding) VALUES (?,?)',
      [memoryId, JSON.stringify(embedding)])
  } catch (e) {
    console.error(`  [memory] embed failed for ${memoryId.slice(0, 8)}:`, e)
  }
}

export function deleteMemoryEmbeddings(memoryIds: string[]): void {
  if (!memoryIds.length) return
  const stmt = sqlite.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?')
  sqlite.transaction(() => { for (const id of memoryIds) stmt.run(id) })()
}

/** Embed any memories that have no vector yet, in one batch. Self-healing: covers databases that
 *  predate this table, rows written while the embedder was down, and dimension changes. */
export async function backfillMemoryEmbeddings(memories: Array<{ id: string; content: string }>): Promise<void> {
  if (!memories.length) return
  const placeholders = memories.map(() => '?').join(',')
  const present = new Set((sqlite.prepare(
    `SELECT memory_id FROM memory_embeddings WHERE memory_id IN (${placeholders})`
  ).all(...memories.map(m => m.id)) as Array<{ memory_id: string }>).map(r => r.memory_id))

  const missing = memories.filter(m => !present.has(m.id))
  if (!missing.length) return
  try {
    const vectors = await embedTexts(missing.map(m => m.content), 'document')
    const stmt = sqlite.prepare('INSERT INTO memory_embeddings(memory_id, embedding) VALUES (?,?)')
    sqlite.transaction(() => {
      for (let i = 0; i < missing.length; i++) stmt.run(missing[i].id, JSON.stringify(vectors[i]))
    })()
    console.log(`  [memory] backfilled ${missing.length} memory embeddings`)
  } catch (e) {
    console.error('  [memory] embedding backfill failed:', e)
  }
}

/** Ids of the given memories ordered by distance from `embedding`, nearest first.
 *
 *  The `memory_id IN (...)` constraint is pushed down into the vector index, so `k` means "k
 *  nearest *within this set*". That distinction matters: sqlite-vec applies `k` before ordinary
 *  JOIN predicates, so scoping by joining another table instead would ask for the k nearest rows
 *  in the whole table and keep whichever survived the filter — frequently none. */
export function nearestMemoryIds(embedding: number[], scopeIds: string[], limit?: number): string[] {
  if (!scopeIds.length) return []
  const placeholders = scopeIds.map(() => '?').join(',')
  const rows = sqlite.prepare(`
    SELECT memory_id
    FROM memory_embeddings
    WHERE embedding MATCH ? AND memory_id IN (${placeholders}) AND k = ?
    ORDER BY distance
  `).all(JSON.stringify(embedding), ...scopeIds, limit ?? scopeIds.length) as Array<{ memory_id: string }>
  return rows.map(r => r.memory_id)
}
