import { randomUUID } from 'crypto'
import { sqlite, db, messages } from './db.ts'
import { eq } from 'drizzle-orm'
import { embedTexts } from './embeddings.ts'

const CHUNK_SIZE = 1000
const MIN_CONTENT_LEN = 20

function chunkContent(content: string): string[] {
  const chunks: string[] = []
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    const chunk = content.slice(i, i + CHUNK_SIZE).trim()
    if (chunk.length >= MIN_CONTENT_LEN) chunks.push(chunk)
  }
  return chunks
}

/** Remove all indexed chunks for a session. */
export function deindexSession(sessionId: string): void {
  sqlite.run('DELETE FROM chat_chunks WHERE chunk_id IN (SELECT chunk_id FROM chat_chunk_meta WHERE session_id = ?)', [sessionId])
  sqlite.run('DELETE FROM chat_chunk_meta WHERE session_id = ?', [sessionId])
}

/** Embed and insert content strings for a session (incremental — does not clear existing chunks). */
export async function indexContents(sessionId: string, contents: string[]): Promise<number> {
  const chunks: Array<{ id: string; content: string }> = []
  for (const content of contents) {
    for (const chunk of chunkContent(content)) {
      chunks.push({ id: randomUUID(), content: chunk })
    }
  }
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
