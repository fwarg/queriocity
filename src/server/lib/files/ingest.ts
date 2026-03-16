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

/** Extract full text from any supported file type without storing anything. */
export async function extractFileText(buffer: ArrayBuffer, mimeType: string): Promise<string> {
  if (mimeType === 'application/pdf') {
    return (await extractPdfChunks(buffer)).join('\n\n')
  }
  if (mimeType.startsWith('image/')) {
    return extractImageText(buffer, mimeType)
  }
  return new TextDecoder().decode(buffer)
}

export async function ingestFile(
  buffer: ArrayBuffer,
  filename: string,
  mimeType: string,
  userId: string,
): Promise<string> {
  const fileId = randomUUID()

  // 1. Extract text chunks
  const fullText = await extractFileText(buffer, mimeType)
  const rawChunks = chunkText(fullText)

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
