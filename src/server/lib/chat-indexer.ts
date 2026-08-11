import { createHash } from 'crypto'
import { sqlite, db, messages } from './db.ts'
import { eq } from 'drizzle-orm'
import { embedTexts } from './embeddings.ts'
import { semanticChunk } from './chunker.ts'

const MIN_CONTENT_LEN = 20

/** Remove all indexed chunks for a session. */
export function deindexSession(sessionId: string): void {
  sqlite.run('DELETE FROM chat_chunks WHERE chunk_id IN (SELECT chunk_id FROM chat_chunk_meta WHERE session_id = ?)', [sessionId])
  sqlite.run('DELETE FROM chat_chunk_meta WHERE session_id = ?', [sessionId])
}

/** Chunk id derived from its content, so indexing the same text twice is a no-op.
 *
 *  Scoped by session because chunks are only ever searched within one, and two sessions quoting the
 *  same paragraph must each keep their own row. */
const chunkId = (sessionId: string, content: string): string =>
  `${sessionId}:${createHash('sha256').update(content).digest('hex').slice(0, 32)}`

/** Split into chunks and drop the ones already indexed for this session. */
function newChunks(sessionId: string, contents: string[]): Array<{ id: string; content: string }> {
  const seen = new Set<string>()
  const chunks: Array<{ id: string; content: string }> = []
  for (const content of contents) {
    for (const chunk of semanticChunk(content, 800, 120, MIN_CONTENT_LEN)) {
      const id = chunkId(sessionId, chunk)
      if (seen.has(id)) continue     // the same text twice within one call
      seen.add(id)
      chunks.push({ id, content: chunk })
    }
  }
  if (!chunks.length) return chunks

  const placeholders = chunks.map(() => '?').join(',')
  const existing = new Set((sqlite.prepare(
    `SELECT chunk_id FROM chat_chunk_meta WHERE chunk_id IN (${placeholders})`
  ).all(...chunks.map(c => c.id)) as Array<{ chunk_id: string }>).map(r => r.chunk_id))
  return chunks.filter(c => !existing.has(c.id))
}

/** Remove specific content from a session's index — the superseded answer after a regenerate.
 *
 *  Without this a rejected answer stays searchable, and chat RAG can surface text the user never
 *  accepted. Content-addressed, so it needs only the old text, not a record of which rows it made. */
export function deindexContent(sessionId: string, content: string): number {
  const ids = semanticChunk(content, 800, 120, MIN_CONTENT_LEN).map(c => chunkId(sessionId, c))
  if (!ids.length) return 0
  const placeholders = ids.map(() => '?').join(',')
  let removed = 0
  sqlite.transaction(() => {
    removed = (sqlite.prepare(
      `SELECT count(*) AS n FROM chat_chunk_meta WHERE chunk_id IN (${placeholders})`
    ).get(...ids) as { n: number }).n
    sqlite.run(`DELETE FROM chat_chunks WHERE chunk_id IN (${placeholders})`, ids)
    sqlite.run(`DELETE FROM chat_chunk_meta WHERE chunk_id IN (${placeholders})`, ids)
  })()
  return removed
}

/** Embed and insert content for a session, skipping anything already indexed.
 *
 *  Idempotent: re-running with the same text costs one cheap id lookup and no embedding calls.
 *  This is what makes a regenerate affordable — it repeats the user's message verbatim, which for a
 *  turn carrying a large attachment used to mean re-embedding the whole document. */
export async function indexContents(sessionId: string, contents: string[]): Promise<number> {
  const chunks = newChunks(sessionId, contents)
  if (!chunks.length) return 0

  const embeddings = await embedTexts(chunks.map(c => c.content))

  const insertMeta = sqlite.prepare('INSERT INTO chat_chunk_meta(chunk_id, session_id, content) VALUES (?,?,?)')
  const insertVec = sqlite.prepare('INSERT INTO chat_chunks(chunk_id, embedding) VALUES (?,?)')
  sqlite.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      insertMeta.run(chunks[i].id, sessionId, chunks[i].content)
      insertVec.run(chunks[i].id, JSON.stringify(embeddings[i]))
    }
  })()

  return chunks.length
}

/** Full (re)index of all messages for a session. Clears existing chunks first. */
export async function indexSession(sessionId: string): Promise<number> {
  deindexSession(sessionId)
  const msgs = await db.select({ content: messages.content }).from(messages)
    .where(eq(messages.sessionId, sessionId))
  const contents = msgs.map(m => m.content).filter(c => c.length >= MIN_CONTENT_LEN)
  if (!contents.length) return 0
  return indexContents(sessionId, contents)
}
