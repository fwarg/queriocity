/** Resource, note and collection excerpts injected into a turn — retrieved like memory, but not stored as it. */

import { sqlite } from '../db.ts'
import { estimateTokens } from '../llm.ts'
import { embedText } from '../embeddings.ts'
import { searchUploads, aboveSimilarity, type ChunkResult } from '../files/uploads-search.ts'
import { rerank, rerankEnabled } from '../reranker.ts'
import { ragTopK, ragMinRelevance, ragMinSimilarity } from '../rag-settings.ts'
import { searchCollections } from '../files/collections.ts'
import { withoutConfidential } from '../files/confidential.ts'
import { trustByNote, trustInstruction } from '../files/note-trust.ts'
import { asDocumentReferences } from '../../../shared/citations.ts'
import { type MemoryBlock } from './recall.ts'

/** Renders retrieved excerpts into a prompt block, spending a token budget newest-relevance-first.
 *
 *  `labelPrefix` keeps two blocks in the same prompt from colliding: a chat can carry both its own
 *  document excerpts and a collection's, and two `[F1]`s pointing at different files would make
 *  every citation in the answer ambiguous. */
function renderFileBlock(
  rows: ChunkResult[],
  ragBudget: number,
  heading: string,
  labelPrefix: string,
  logTag: string,
): MemoryBlock {
  if (!rows.length) return { block: '', fileSources: [] }

  const citedFiles = new Map<string, { filename: string; label: string }>()
  let fileCounter = 0
  let ragRemaining = ragBudget
  const fileLines: string[] = []

  for (const chunk of rows) {
    const cost = estimateTokens(chunk.content)
    if (cost > ragRemaining) continue
    ragRemaining -= cost
    if (!citedFiles.has(chunk.fileId)) {
      citedFiles.set(chunk.fileId, { filename: chunk.filename, label: `${labelPrefix}${++fileCounter}` })
    }
    const { label } = citedFiles.get(chunk.fileId)!
    fileLines.push(`[${label}] ${asDocumentReferences(chunk.content)}`)
    console.log(`    [rag:${logTag}] ${chunk.content.length} chars: ${JSON.stringify(chunk.content.slice(0, 60))}`)
    if (ragRemaining <= 0) break
  }

  if (!fileLines.length) return { block: '', fileSources: [] }

  const fileSources = Array.from(citedFiles.entries())
    .map(([fileId, { filename, label }]) => ({ title: `[${label}] ${filename}`, url: `file:${fileId}`, label }))

  let block = `## ${heading}\n` + fileLines.map(l => `> ${l}`).join('\n\n')
  block += `\n\nWhen your answer draws on the excerpts above, cite them inline using their label (e.g. [${labelPrefix}1]). This is separate from any [N] web-source citations you are also instructed to use elsewhere — use both where appropriate, and do not invent any other citation format. A document's own references appear as (ref. 7): they are not sources, so never cite them as [7].`

  console.log(`  [memory] ${logTag}: ${fileLines.length} chunks, ${fileSources.length} files (~${estimateTokens(block)} tokens)`)
  return { block, fileSources }
}

/** Build a file RAG block for non-space chats from the user's own uploaded files. `withoutNotes`
 *  when "Notes first" already supplies the notes, so they are not injected twice. */
export async function buildChatFileBlock(
  userId: string,
  query: string,
  ragBudget = 500,
  withoutNotes = false,
  includeConfidential = false,
): Promise<MemoryBlock> {
  if (!query.trim() || ragBudget <= 0) return { block: '', fileSources: [] }

  let fileRows: ChunkResult[] = []
  try {
    fileRows = await searchUploads(query, userId, await ragTopK(), await ragMinRelevance(), withoutNotes ? 'file' : undefined, includeConfidential)
  } catch (e) {
    console.error('  [memory] chat file RAG failed:', e)
    return { block: '', fileSources: [] }
  }

  return renderFileBlock(fileRows, ragBudget, 'Relevant document excerpts', 'F', 'chat-file')
}

/** "Notes first": the user's notes most relevant to the query, then the opening of each note they
 *  link to or are linked from — one hop, so a note brings its context along. Labelled [N1]… */
export async function buildNotesBlock(userId: string, query: string, ragBudget: number, includeConfidential = false): Promise<MemoryBlock> {
  if (!query.trim() || ragBudget <= 0) return { block: '', fileSources: [] }
  let hits: ChunkResult[] = []
  try {
    hits = await searchUploads(query, userId, await ragTopK(), await ragMinRelevance(), 'note', includeConfidential)
  } catch (e) {
    console.error('  [memory] notes RAG failed:', e)
    return { block: '', fileSources: [] }
  }
  const found = [...hits, ...linkedNoteOpenings(userId, [...new Set(hits.map(h => h.fileId))], includeConfidential)]
  // Deprecated notes are kept for links and history, not as what the user currently holds true.
  const trust = trustByNote([...new Set(found.map(r => r.fileId))])
  const rows = found.filter(r => trust.get(r.fileId)?.status !== 'deprecated')
  const rendered = renderFileBlock(rows, ragBudget, 'Your own notes (most relevant first, then notes they link with)', 'N', 'notes')
  if (!rendered.block) return rendered
  const caution = trustInstruction(rendered.fileSources)
  return { ...rendered, block: `${rendered.block}${caution ? `\n\n${caution}` : ''}

The user asked for an answer from their own notes first. Base the answer on the notes above; search the web only for what they do not cover, and make clear which parts come from the notes and which from elsewhere.` }
}

/** The first chunk of each note linked with any of `noteIds`, either direction, not already among them. */
function linkedNoteOpenings(userId: string, noteIds: string[], includeConfidential: boolean): ChunkResult[] {
  if (!noteIds.length) return []
  const marks = noteIds.map(() => '?').join(',')
  return sqlite.query(`
    SELECT m.chunk_id AS chunkId, f.id AS fileId, f.filename, m.content, 0 AS distance
    FROM uploaded_files f JOIN file_chunk_meta m ON m.file_id = f.id AND m.chunk_id = f.id || ':0'
    WHERE f.user_id = ? AND f.kind = 'note' AND f.id NOT IN (${marks}) AND f.id IN (
      SELECT dst_id FROM resource_links WHERE src_id IN (${marks})
      UNION SELECT src_id FROM resource_links WHERE dst_id IN (${marks})
    ) ${withoutConfidential('f.id', includeConfidential)}
  `).all(userId, ...noteIds, ...noteIds, ...noteIds) as ChunkResult[]
}

/** Excerpts from the collections picked for this request, whether or not the chat is in a space.
 *
 *  A block of its own rather than another source folded into `buildMemoryBlock`'s joint rerank: the
 *  selection is an explicit per-query act, so these documents were asked for and should not have to
 *  out-compete whatever the space itself holds. The cost is a second budget — a request with
 *  collections selected carries a larger prompt — and no cross-ranking between the two. */
export async function buildCollectionBlock(
  collectionIds: string[],
  query: string,
  ragBudget = 500,
  includeConfidential = false,
): Promise<MemoryBlock> {
  if (!collectionIds.length || !query.trim() || ragBudget <= 0) return { block: '', fileSources: [] }

  let rows: ChunkResult[] = []
  try {
    const embedding = await embedText(query, 'query')
    rows = await searchCollections(collectionIds, query, embedding, undefined, includeConfidential)
    if (rerankEnabled() && rows.length) {
      const order = await rerank(query, rows.map(r => r.content), rows.length, await ragMinRelevance())
      rows = order.map(i => rows[i])
    } else {
      rows = aboveSimilarity(rows, await ragMinSimilarity(), 'rag:collection')
    }
  } catch (e) {
    console.error('  [memory] collection RAG failed:', e)
    return { block: '', fileSources: [] }
  }

  return renderFileBlock(rows, ragBudget, 'Excerpts from selected collections', 'C', 'collection')
}
