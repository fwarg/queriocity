import { createHash } from 'crypto'
import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { sqlite, db, uploadedFiles } from '../db.ts'
import { embedTexts } from '../embeddings.ts'
import { semanticChunk } from '../chunker.ts'
import { extractPdfChunks } from './pdf.ts'
import { extractImageText } from './image.ts'

export const ACCEPTED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

const CHUNK_CONFIG: Record<string, { size: number; overlap: number }> = {
  image: { size: 1000, overlap: 150 },
  doc:   { size: 2000, overlap: 300 },
}

function chunkConfig(mimeType: string) {
  return mimeType.startsWith('image/') ? CHUNK_CONFIG.image : CHUNK_CONFIG.doc
}

/** Returns false if text is too short or contains too many non-printable characters. */
export function isUsableText(text: string): boolean {
  if (text.trim().length < 50) return false
  const nonPrintable = (text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f�]/g) ?? []).length
  return nonPrintable / text.length < 0.15
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
  if (!ACCEPTED_MIME_TYPES.has(mimeType.split(';')[0].trim())) {
    throw new Error(`Unsupported file type: ${mimeType}. Accepted types: PDF, plain text, images.`)
  }

  // Dedup: return existing fileId if this user already uploaded identical content
  const contentHash = createHash('sha256').update(Buffer.from(buffer)).digest('hex')
  const existing = await db.select({ id: uploadedFiles.id })
    .from(uploadedFiles)
    .where(and(eq(uploadedFiles.userId, userId), eq(uploadedFiles.contentHash, contentHash)))
    .get()
  if (existing) return existing.id

  const fileId = randomUUID()

  // 1. Extract and chunk text
  const fullText = await extractFileText(buffer, mimeType)
  if (!isUsableText(fullText)) {
    throw new Error('Could not extract readable text from this file. It may be corrupted or in an unsupported encoding.')
  }
  const { size, overlap } = chunkConfig(mimeType)
  const rawChunks = semanticChunk(fullText, size, overlap, 50)

  // 2. Embed all chunks
  const embeddings = await embedTexts(rawChunks)

  // 3. Persist file record
  await db.insert(uploadedFiles).values({
    id: fileId,
    userId,
    filename,
    mimeType,
    size: buffer.byteLength,
    contentHash,
    createdAt: new Date(),
  })

  // 4. Insert chunks + embeddings
  const insertChunk = sqlite.prepare(
    'INSERT INTO file_chunk_meta (chunk_id, file_id, content) VALUES (?,?,?)',
  )
  const insertVec = sqlite.prepare(
    'INSERT INTO file_chunks (chunk_id, embedding) VALUES (?,?)',
  )

  sqlite.transaction(() => {
    for (let i = 0; i < rawChunks.length; i++) {
      const chunkId = `${fileId}:${i}`
      insertChunk.run(chunkId, fileId, rawChunks[i])
      insertVec.run(chunkId, JSON.stringify(embeddings[i]))
    }
  })()

  return fileId
}
