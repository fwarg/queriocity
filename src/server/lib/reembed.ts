import { sqlite } from './db.ts'
import { embedTexts } from './embeddings.ts'

/** Rebuilds vectors whose text is still on disk.
 *
 *  A vector is derived data. The text it was built from lives in `*_chunk_meta.content`, and chunk
 *  boundaries follow the mime type rather than the embedding model — so changing EMBED_DIMENSIONS
 *  invalidates every vector but nothing else. Recovering from that is re-embedding what is already
 *  stored; it never needs re-chunking, and it never needs a resource to be deleted and re-uploaded.
 *
 *  Also covers the smaller case of an indexing run whose embedding call failed after its chunk text
 *  was written — the same query finds both, because both leave text with no vector. */

/** Chunks per pass. `embedTexts` batches by total characters underneath, so this bounds how much is
 *  read into memory and how much is lost to a mid-run crash, not the request size. */
const PAGE = 200

interface ChunkTable {
  vectors: string
  meta: string
  label: string
}

const TABLES: ChunkTable[] = [
  { vectors: 'file_chunks', meta: 'file_chunk_meta', label: 'resource' },
  { vectors: 'chat_chunks', meta: 'chat_chunk_meta', label: 'chat' },
]

const countMissing = (t: ChunkTable): number =>
  (sqlite.query(
    `SELECT count(*) AS n FROM ${t.meta} WHERE chunk_id NOT IN (SELECT chunk_id FROM ${t.vectors})`,
  ).get() as { n: number }).n

/** Re-embeds one table's unvectorised chunks. Returns how many vectors it wrote. */
async function reembedTable(t: ChunkTable): Promise<number> {
  const missing = countMissing(t)
  if (missing === 0) return 0

  console.log(`  [reembed] ${missing} ${t.label} chunk(s) have text but no vector — rebuilding`)
  const insert = sqlite.prepare(`INSERT INTO ${t.vectors} (chunk_id, embedding) VALUES (?,?)`)
  let done = 0

  // Re-queried each pass rather than paged with OFFSET: the rows written by the previous pass leave
  // the result set, so a fixed offset would step over the ones behind them.
  for (;;) {
    const page = sqlite.query(
      `SELECT chunk_id AS chunkId, content FROM ${t.meta}
       WHERE chunk_id NOT IN (SELECT chunk_id FROM ${t.vectors}) LIMIT ${PAGE}`,
    ).all() as Array<{ chunkId: string; content: string }>
    if (!page.length) break

    const embeddings = await embedTexts(page.map(c => c.content))
    sqlite.transaction(() => {
      page.forEach((chunk, i) => insert.run(chunk.chunkId, JSON.stringify(embeddings[i])))
    })()
    done += page.length
    if (done < missing) console.log(`  [reembed] ${t.label}: ${done}/${missing}`)
  }

  console.log(`  [reembed] ${t.label}: ${done} vector(s) rebuilt`)
  return done
}

/** Rebuilds every missing vector, table by table. Never throws: a failure leaves the remaining
 *  chunks unvectorised and the next start tries again, which is strictly better than refusing to
 *  serve. Retrieval degrades in the meantime rather than losing anything. */
export async function reembedMissingVectors(): Promise<number> {
  let total = 0
  for (const table of TABLES) {
    try {
      total += await reembedTable(table)
    } catch (e) {
      console.error(`  [reembed] ${table.label} chunks failed, will retry at next start: ${e instanceof Error ? e.message : e}`)
    }
  }
  return total
}
