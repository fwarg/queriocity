import { createHash } from 'node:crypto'
import { generateText } from 'ai'
import { sqlite } from '../db.ts'
import { languageModel, modelTarget, SMALL_MODEL_INPUT_CHARS } from '../llm.ts'
import { LANGUAGE_RULE } from './transforms.ts'
import { withoutThinking } from './collection-digests.ts'

/** A document as numbered parts, for exploring it a part at a time (turn/collection-agent.ts).
 *
 *  A part is a run of consecutive indexed excerpts — the same chunks retrieval embeds — so nothing is
 *  stored twice and a search hit names its part exactly. Neighbouring excerpts overlap; a part drops
 *  the repeat so it reads as continuous text. Each part has a one-line outline, written once by the
 *  small model and cached by the part's content, so it changes only when the document is re-indexed. */

/** Excerpts per part: about 5k characters of new text with the ingest chunk size (2000, overlap 300). */
export const PART_CHUNKS = 3
const OUTLINE_LINE_CHARS = 200
const OUTLINE_MAX_TOKENS = 150
/** The shortest repeat taken for chunk overlap; anything shorter may be coincidence. */
const MIN_OVERLAP = 40
const MAX_OVERLAP = 600

const OUTLINE_SYSTEM = `You describe one part of a document in a single line of at most ${OUTLINE_LINE_CHARS} characters: what it covers, naming any section headings it contains. No preamble. ${LANGUAGE_RULE}`

export interface DocPart {
  /** 1-based. */
  index: number
  text: string
}

/** The part a chunk falls in; chunk numbers are the 0-based suffixes of `file_chunk_meta.chunk_id`. */
export const partOfChunk = (chunkNumber: number) => Math.floor(chunkNumber / PART_CHUNKS) + 1

/** A document's parts, in order. */
export function documentParts(fileId: string): DocPart[] {
  const chunks = (sqlite.prepare(`
    SELECT content FROM file_chunk_meta WHERE file_id = ?
    ORDER BY CAST(substr(chunk_id, instr(chunk_id, ':') + 1) AS INTEGER)
  `).all(fileId) as Array<{ content: string }>).map(c => c.content)
  const parts: DocPart[] = []
  for (let i = 0; i < chunks.length; i += PART_CHUNKS) {
    parts.push({ index: parts.length + 1, text: joinChunks(chunks.slice(i, i + PART_CHUNKS)) })
  }
  return parts
}

/** Consecutive excerpts as one text, each one's opening repeat of the previous one's end removed. */
export function joinChunks(chunks: string[]): string {
  let text = chunks[0] ?? ''
  for (const next of chunks.slice(1)) {
    const overlap = overlapLength(text, next)
    text += (overlap ? '' : '\n') + next.slice(overlap)
  }
  return text
}

/** How much of `next`'s opening repeats `prev`'s end; 0 when no repeat is long enough to trust. */
function overlapLength(prev: string, next: string): number {
  for (let k = Math.min(MAX_OVERLAP, prev.length, next.length); k >= MIN_OVERLAP; k--) {
    if (prev.endsWith(next.slice(0, k))) return k
  }
  return 0
}

/** One outline line per part, from the cache or written by the small model. A failed call gives the
 *  part's opening instead, uncached, so the outline still has a line for every part. */
export async function outlineOf(fileId: string, parts: DocPart[], abortSignal?: AbortSignal): Promise<string[]> {
  const lines: string[] = []
  for (const part of parts) lines.push(await outlineLine(fileId, part, abortSignal))
  return lines
}

async function outlineLine(fileId: string, part: DocPart, abortSignal?: AbortSignal): Promise<string> {
  const input = part.text.slice(0, SMALL_MODEL_INPUT_CHARS)
  const hash = createHash('sha256').update(OUTLINE_SYSTEM).update('\0').update(input).digest('hex')
  const cached = sqlite.prepare('SELECT line FROM resource_outlines WHERE file_id = ? AND part_hash = ?')
    .get(fileId, hash) as { line: string } | null
  if (cached) return cached.line
  try {
    const small = modelTarget('small')
    const { text } = await generateText({ model: languageModel(small), system: OUTLINE_SYSTEM, prompt: input, maxOutputTokens: OUTLINE_MAX_TOKENS, abortSignal })
    const line = withoutThinking(text).replace(/\s+/g, ' ').slice(0, OUTLINE_LINE_CHARS * 2)
    if (!line) throw new Error('empty outline line')
    sqlite.prepare('INSERT OR REPLACE INTO resource_outlines(file_id, part_hash, line, created_at) VALUES (?,?,?,?)')
      .run(fileId, hash, line, Date.now())
    return line
  } catch (e) {
    if (abortSignal?.aborted) throw e
    console.error(`  [outline] part ${part.index} of ${fileId} failed:`, e)
    return part.text.replace(/\s+/g, ' ').slice(0, 120) + '…'
  }
}
