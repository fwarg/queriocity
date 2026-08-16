import { sqlite } from '../db.ts'

/** Reassembles the stored text of one or more resources, for prompts that read a document whole
 *  rather than retrieving from it.
 *
 *  Chunks are the only copy of an uploaded file's text, so this is how a transform sees it. They
 *  overlap, which means the reassembly repeats a sentence at every seam — acceptable for a model
 *  reading for content, and the reason this is not offered as a way to *display* a file.
 *
 *  Callers must have verified ownership: the file ids are used as given. */

export interface ResourceContext {
  /** The assembled text, each resource preceded by a `[filename]` header. */
  text: string
  /** Chunks the resources hold in total, which may exceed the number included. */
  chunkCount: number
  /** True when `maxChars` cut the text short. */
  truncated: boolean
}

export function collectResourceText(fileIds: string[], maxChars: number): ResourceContext {
  if (!fileIds.length) return { text: '', chunkCount: 0, truncated: false }

  const placeholders = fileIds.map(() => '?').join(',')
  const chunks = sqlite.prepare(`
    SELECT m.content, f.filename
    FROM file_chunk_meta m
    JOIN uploaded_files f ON f.id = m.file_id
    WHERE m.file_id IN (${placeholders})
    ORDER BY m.file_id, CAST(substr(m.chunk_id, instr(m.chunk_id, ':') + 1) AS INTEGER)
  `).all(...fileIds) as Array<{ content: string; filename: string }>
  // Ordered by the numeric suffix, not by chunk_id: the id is `<uuid>:<n>`, so a text sort puts
  // chunk 10 before chunk 2 and hands the model a document with its middle shuffled. Any file with
  // ten or more chunks — which is most PDFs — was affected.

  const sections: string[] = []
  let totalChars = 0
  let lastFile = ''
  let used = 0
  for (const chunk of chunks) {
    if (totalChars >= maxChars) break
    if (chunk.filename !== lastFile) { sections.push(`\n[${chunk.filename}]`); lastFile = chunk.filename }
    sections.push(chunk.content)
    totalChars += chunk.content.length
    used++
  }

  return {
    text: sections.join('\n').slice(0, maxChars),
    chunkCount: chunks.length,
    truncated: used < chunks.length,
  }
}
