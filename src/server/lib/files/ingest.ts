import { createHash } from 'crypto'
import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { sqlite, db, uploadedFiles } from '../db.ts'
import { embedTexts } from '../embeddings.ts'
import { semanticChunk } from '../chunker.ts'
import { deleteFileChunks } from '../vector-cleanup.ts'
import { extractPdfChunks } from './pdf.ts'
import { extractImageText } from './image.ts'
import { describeResource } from './summarise.ts'

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

/** The largest chunk any indexing path stores, so config-check can verify the embedding bound sits
 *  above it. ~500 tokens, which is where retrieval quality peaks — long passages average into a
 *  vector that matches everything weakly. Exported rather than repeated as a literal. */
export const LARGEST_CHUNK_CHARS = Math.max(...Object.values(CHUNK_CONFIG).map(c => c.size))

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

/** The shortest chunk worth storing, for text an extractor produced. Drops the page numbers and
 *  stray captions a PDF leaves behind, which embed to noise. Text a person typed is exempt — see
 *  `minChunkChars` below. */
const MIN_EXTRACTED_CHUNK_CHARS = 50

/** Chunks, embeds and stores text for a resource, replacing any chunks it already has.
 *
 *  Replacing rather than appending is what lets a note be edited: `deleteFileChunks` clears both the
 *  meta rows and the vec0 vectors, which have no foreign key to cascade through. Returns the number
 *  of chunks written.
 *
 *  `minChunkChars` is 0 for notes: a one-line note is deliberate, and dropping it would leave a
 *  resource the user can see in the library but retrieval can never find. */
export async function indexResourceText(
  fileId: string,
  text: string,
  mimeType: string,
  minChunkChars = MIN_EXTRACTED_CHUNK_CHARS,
): Promise<number> {
  const { size, overlap } = chunkConfig(mimeType)
  const rawChunks = semanticChunk(text, size, overlap, minChunkChars)
  const embeddings = await embedTexts(rawChunks)

  deleteFileChunks(fileId)
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
  return rawChunks.length
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

  // Dedup: return the existing fileId if this user already uploaded identical content — but only
  // if that upload actually completed. A row whose indexing failed keeps its content hash, so
  // without this check the retry matches it, returns instantly, and hands back a resource with no
  // excerpts and no way to fix it but deleting it by hand.
  const contentHash = createHash('sha256').update(Buffer.from(buffer)).digest('hex')
  const existing = await db.select({ id: uploadedFiles.id })
    .from(uploadedFiles)
    .where(and(eq(uploadedFiles.userId, userId), eq(uploadedFiles.contentHash, contentHash)))
    .get()
  if (existing && chunkCount(existing.id) > 0) return existing.id
  if (existing) {
    console.warn(`  [ingest] "${filename}" matches ${existing.id}, which has no excerpts — re-ingesting over it`)
    await removeResource(existing.id)
  }

  const fileId = randomUUID()

  // 1. Extract text
  const fullText = await extractFileText(buffer, mimeType)
  if (!isUsableText(fullText)) {
    throw new Error('Could not extract readable text from this file. It may be corrupted or in an unsupported encoding.')
  }

  // 2. Persist file record, then index. The row goes first so `describeResource` has something to
  //    update, and is rolled back if indexing fails: a file whose text exists only in its chunks is
  //    nothing without them, and leaving the row behind also poisons the dedup check above.
  //    A note is the opposite case and deliberately keeps its row — see notes.ts.
  await db.insert(uploadedFiles).values({
    id: fileId,
    userId,
    filename,
    mimeType,
    size: buffer.byteLength,
    contentHash,
    kind: 'file',
    createdAt: new Date(),
  })
  try {
    await indexResourceText(fileId, fullText, mimeType)
  } catch (e) {
    await removeResource(fileId)
    throw e
  }

  // 3. Summarise — best-effort, after the row is durable. A small-model outage must not lose an
  //    upload the user has already waited through extraction and embedding for.
  await describeResource(fileId, fullText)

  return fileId
}

const chunkCount = (fileId: string): number =>
  (sqlite.query('SELECT count(*) AS n FROM file_chunk_meta WHERE file_id = ?').get(fileId) as { n: number }).n

/** Removes a resource and everything keyed to it. Chunks first: their tables carry no foreign key. */
async function removeResource(fileId: string): Promise<void> {
  deleteFileChunks(fileId)
  await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId))
}
