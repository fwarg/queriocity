import { randomUUID } from 'crypto'
import { sqlite, db, uploadedFiles } from '../db.ts'
import { embedTexts } from '../embeddings.ts'
import { extractPdfChunks } from './pdf.ts'
import { extractImageText } from './image.ts'

const CHUNK_SIZE = 1000 // chars

function chunkText(text: string): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    const chunk = text.slice(i, i + CHUNK_SIZE).trim()
    if (chunk) chunks.push(chunk)
  }
  return chunks
}

export async function ingestFile(
  buffer: ArrayBuffer,
  filename: string,
  mimeType: string,
  userId: string,
): Promise<string> {
  const fileId = randomUUID()

  // 1. Extract text chunks
  let rawChunks: string[]
  if (mimeType === 'application/pdf') {
    rawChunks = await extractPdfChunks(buffer)
  } else if (mimeType.startsWith('image/')) {
    const text = await extractImageText(buffer, mimeType)
    rawChunks = chunkText(text)
  } else {
    // Plain text / markdown
    const text = new TextDecoder().decode(buffer)
    rawChunks = chunkText(text)
  }

  // 2. Embed all chunks
  const embeddings = await embedTexts(rawChunks)

  // 3. Persist file record
  await db.insert(uploadedFiles).values({
    id: fileId,
    userId,
    filename,
    mimeType,
    size: buffer.byteLength,
    createdAt: new Date(),
  })

  // 4. Insert chunks + embeddings
  const insertChunk = sqlite.prepare(
    'INSERT INTO file_chunk_meta (chunk_id, file_id, content) VALUES (?,?,?)',
  )
  const insertVec = sqlite.prepare(
    'INSERT INTO file_chunks (chunk_id, embedding) VALUES (?,?)',
  )

  const insertAll = sqlite.transaction(() => {
    for (let i = 0; i < rawChunks.length; i++) {
      const chunkId = `${fileId}:${i}`
      insertChunk.run(chunkId, fileId, rawChunks[i])
      insertVec.run(chunkId, JSON.stringify(embeddings[i]))
    }
  })
  insertAll()

  return fileId
}
