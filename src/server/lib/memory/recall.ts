/** Choosing which space memories and past chats go into a turn, within a token budget. */

import { sqlite } from '../db.ts'
import { estimateTokens } from '../llm.ts'
import { embedText } from '../embeddings.ts'
import { searchSpaceFiles, spaceHasTaggedFiles, type ChunkResult } from '../files/uploads-search.ts'
import { rerank, rerankEnabled } from '../reranker.ts'
import { ragTopK, ragMinRelevance } from '../rag-settings.ts'
import { asDocumentReferences } from '../../../shared/citations.ts'
import { getSpaceMemories, backfillMemoryEmbeddings, nearestMemoryIds } from './store.ts'

export interface HistoryHit {
  session: string
  date: string
  content: string
}

/** Semantic search over past conversations in a space, for the search_space_history tool.
 *  Same KNN as the passive RAG block in buildMemoryBlock, but with a model-chosen query and k,
 *  and carrying session title + date so the model can tell when something was said. */
export async function searchSpaceHistory(
  spaceId: string,
  query: string,
  k?: number,
  excludeSessionId?: string,
): Promise<HistoryHit[]> {
  if (!query.trim()) return []
  const topK = k ?? await ragTopK()
  let embedding: number[]
  try {
    embedding = await embedText(query)
  } catch (e) {
    console.error('  [memory] history search embed failed:', e)
    return []
  }
  try {
    // Scoping lives in a pushed-down IN, not in JOIN predicates: sqlite-vec applies `k` before
    // joined-table filters, so filtering afterwards asks for the k nearest chunks in the entire
    // database and keeps whichever happen to be this space's — often none. See searchSpaceFiles.
    const rows = sqlite.prepare(`
      SELECT ccm.content, cs.title, cs.updated_at
      FROM chat_chunks cc
      JOIN chat_chunk_meta ccm ON ccm.chunk_id = cc.chunk_id
      JOIN chat_sessions cs ON cs.id = ccm.session_id
      WHERE cc.embedding MATCH ?
        AND k = ?
        AND cc.chunk_id IN (
          SELECT m2.chunk_id FROM chat_chunk_meta m2
          JOIN chat_sessions s2 ON s2.id = m2.session_id
          WHERE s2.space_id = ? AND s2.id IS NOT ?
        )
      ORDER BY cc.distance
    `).all(JSON.stringify(embedding), topK, spaceId, excludeSessionId ?? null) as
      Array<{ content: string; title: string; updated_at: number }>
    console.log(`  [memory] search_space_history "${query.slice(0, 60)}" → ${rows.length} hits`)
    return rows.map(r => ({
      session: r.title,
      // Drizzle's `mode: 'timestamp'` stores seconds, and this is raw SQL, so scale to ms.
      date: new Date(r.updated_at * 1000).toISOString().slice(0, 10),
      content: r.content,
    }))
  } catch (e) {
    console.error('  [memory] history search failed:', e)
    return []
  }
}

/** Order the given memories by relevance to the query, best first.
 *  Returns null when ranking is unavailable, so the caller can fall back to recency. */
export async function rankMemoriesByRelevance<T extends { id: string; content: string }>(
  memories: T[],
  query: string,
  embedding: number[],
): Promise<T[] | null> {
  await backfillMemoryEmbeddings(memories)
  const byId = new Map(memories.map(m => [m.id, m]))
  let ordered: T[]
  try {
    const ids = nearestMemoryIds(embedding, memories.map(m => m.id))
    if (!ids.length) return null
    ordered = ids.map(id => byId.get(id)).filter((m): m is T => m != null)
  } catch (e) {
    console.error('  [memory] memory ranking failed:', e)
    return null
  }

  if (rerankEnabled() && ordered.length > 1) {
    const indices = await rerank(query, ordered.map(m => m.content), ordered.length)
    ordered = indices.map(i => ordered[i]).filter(Boolean)
  }

  // Anything without a usable vector still belongs in the list, just last.
  const seen = new Set(ordered.map(m => m.id))
  return [...ordered, ...memories.filter(m => !seen.has(m.id))]
}

export interface MemoryCandidate {
  id: string
  content: string
}

/** Fit memories into the token budget: guaranteed entries first, then ranked ones until full.
 *  Pure — the budget arithmetic is unit-tested without an embedder or a model. */
export function selectMemories<T extends MemoryCandidate>(
  guaranteed: T[],
  ranked: T[],
  tokenBudget: number,
): { chosen: T[]; droppedGuaranteed: number } {
  const cost = (m: T) => estimateTokens(`- ${m.content}`)
  let remaining = tokenBudget
  const chosen: T[] = []
  let droppedGuaranteed = 0

  for (const m of guaranteed) {
    const c = cost(m)
    if (c > remaining) { droppedGuaranteed++; continue }
    remaining -= c
    chosen.push(m)
  }
  for (const m of ranked) {
    const c = cost(m)
    if (c > remaining) continue
    remaining -= c
    chosen.push(m)
  }
  return { chosen, droppedGuaranteed }
}

export interface MemoryBlock {
  block: string
  fileSources: Array<{ title: string; url: string; label: string }>
}

/** Build a formatted memory block for system prompt injection, with optional RAG layer. */
export async function buildMemoryBlock(
  spaceId: string,
  tokenBudget = 1500,
  ragBudget = 0,
  query?: string,
  includeFileIds?: string[],
  includeMemoryIds?: string[],
  includeConfidential = false,
): Promise<MemoryBlock> {
  const allMemories = await getSpaceMemories(spaceId)
  if (!allMemories.length) return { block: '', fileSources: [] }

  const header = '## Space Memory\nThe following facts were accumulated from previous conversations in this space. Use them to inform your responses.'
  const headerTokens = estimateTokens(header)

  // Embed the query once and share it: memory ranking, chat RAG and file RAG all need it.
  let embedding: number[] | null = null
  if (query?.trim()) {
    try {
      embedding = await embedText(query)
    } catch (e) {
      console.error('  [memory] RAG embed failed:', e)
    }
  }

  // Pinned (this request) and always-keep (persistent) memories are guaranteed a slot; the rest
  // compete on relevance. Without a query or an embedder we keep the historical newest-first
  // order, which is what every install had before ranking existed.
  const pinned = new Set(includeMemoryIds ?? [])
  const guaranteed = allMemories.filter(m => m.alwaysKeep || pinned.has(m.id))
  const guaranteedIds = new Set(guaranteed.map(m => m.id))
  const rest = allMemories.filter(m => !guaranteedIds.has(m.id))

  const ranked = (embedding && query?.trim() && rest.length)
    ? (await rankMemoriesByRelevance(rest, query, embedding)) ?? rest
    : rest

  const { chosen, droppedGuaranteed } = selectMemories(guaranteed, ranked, tokenBudget - headerTokens)
  if (droppedGuaranteed > 0) {
    console.warn(`  [memory] ${droppedGuaranteed} pinned/always-keep memories did not fit the ${tokenBudget}-token budget`)
  }
  if (!chosen.length) return { block: '', fileSources: [] }

  const lines = chosen.map(m => `- ${m.content}`)
  let block = header + '\n' + lines.join('\n')
  let ragInjected = 0
  const citedFiles = new Map<string, { filename: string; label: string }>()
  let fileCounter = 0

  if (ragBudget > 0 && query?.trim()) {
    let ragRemaining = ragBudget
    const hasTaggedFiles = spaceHasTaggedFiles(spaceId)

    if (embedding) {
      // Fetch candidates from both sources
      const topK = await ragTopK()
      let chatRows: Array<{ chunk_id: string; content: string }> = []
      try {
        // Space scoping via pushed-down IN rather than a JOIN predicate — with `AND cs.space_id`
        // outside, `k` would mean "k nearest chunks anywhere", and a busy neighbouring space
        // leaves this one with nothing. See the note on searchSpaceFiles.
        chatRows = sqlite.prepare(`
          SELECT ccm.chunk_id, ccm.content
          FROM chat_chunks cc
          JOIN chat_chunk_meta ccm ON ccm.chunk_id = cc.chunk_id
          WHERE cc.embedding MATCH ?
            AND k = ?
            AND cc.chunk_id IN (
              SELECT m2.chunk_id FROM chat_chunk_meta m2
              JOIN chat_sessions s2 ON s2.id = m2.session_id
              WHERE s2.space_id = ?
            )
          ORDER BY cc.distance
        `).all(JSON.stringify(embedding), topK, spaceId) as Array<{ chunk_id: string; content: string }>
      } catch (e) {
        console.error('  [memory] chat RAG search failed:', e)
      }

      let fileRows: ChunkResult[] = []
      if (hasTaggedFiles) {
        try {
          fileRows = await searchSpaceFiles(spaceId, query, embedding, topK, true, includeFileIds, undefined, includeConfidential)
        } catch (e) {
          console.error('  [memory] space file RAG failed:', e)
        }
      }

      const labelFileChunk = (fileId: string, filename: string, content: string): string => {
        if (!citedFiles.has(fileId)) {
          citedFiles.set(fileId, { filename, label: `F${++fileCounter}` })
        }
        const { label } = citedFiles.get(fileId)!
        return `[${label}] ${asDocumentReferences(content)}`
      }

      if (rerankEnabled() && (chatRows.length + fileRows.length) > 0) {
        // Joint rerank: cross-encoder scores let chat and file chunks compete fairly
        console.log(`  [rag:rerank] joint reranking ${chatRows.length} chat + ${fileRows.length} file candidates`)
        const combined = [
          ...chatRows.map(r => ({ content: r.content, source: 'chat' as const, fileId: '', filename: '' })),
          ...fileRows.map(r => ({ content: r.content, source: 'file' as const, fileId: r.fileId, filename: r.filename })),
        ]
        const indices = await rerank(query, combined.map(r => r.content), combined.length, await ragMinRelevance())
        const chatLines: string[] = []
        const fileLines: string[] = []
        for (const idx of indices) {
          const item = combined[idx]
          const cost = estimateTokens(item.content)
          if (cost > ragRemaining) continue
          ragRemaining -= cost
          if (item.source === 'chat') {
            chatLines.push(item.content)
            console.log(`    [rag:chat] ${item.content.length} chars: ${JSON.stringify(item.content.slice(0, 60))}`)
          } else {
            fileLines.push(labelFileChunk(item.fileId, item.filename, item.content))
            console.log(`    [rag:file] ${item.content.length} chars: ${JSON.stringify(item.content.slice(0, 60))}`)
          }
          ragInjected++
          if (ragRemaining <= 0) break
        }
        if (chatLines.length) block += '\n\n## Relevant past conversations\n' + chatLines.map(l => `> ${l}`).join('\n\n')
        if (fileLines.length) block += '\n\n## Relevant document excerpts\n' + fileLines.map(l => `> ${l}`).join('\n\n')
      } else {
        // No reranker: 50/50 budget split so files are never fully crowded out
        let chatRemaining = Math.floor(ragBudget / 2)
        let fileRemaining = ragBudget - chatRemaining

        const chatLines: string[] = []
        for (const row of chatRows) {
          const cost = estimateTokens(row.content)
          if (cost > chatRemaining) break
          chatRemaining -= cost
          chatLines.push(row.content)
          ragInjected++
          console.log(`    [rag:chat] ${row.content.length} chars: ${JSON.stringify(row.content.slice(0, 60))}`)
        }
        if (chatLines.length) block += '\n\n## Relevant past conversations\n' + chatLines.map(l => `> ${l}`).join('\n\n')

        if (fileRows.length && fileRemaining > 0) {
          const fileLines: string[] = []
          for (const chunk of fileRows) {
            const cost = estimateTokens(chunk.content)
            if (cost > fileRemaining) break
            fileRemaining -= cost
            fileLines.push(labelFileChunk(chunk.fileId, chunk.filename, chunk.content))
            ragInjected++
            console.log(`    [rag:file] ${chunk.content.length} chars: ${JSON.stringify(chunk.content.slice(0, 60))}`)
          }
          if (fileLines.length) block += '\n\n## Relevant document excerpts\n' + fileLines.map(l => `> ${l}`).join('\n\n')
        }
      }
    }
  }

  const fileSources = Array.from(citedFiles.entries())
    .map(([fileId, { filename, label }]) => ({ title: `[${label}] ${filename}`, url: `file:${fileId}`, label }))
  if (fileSources.length > 0) {
    block += '\n\nWhen your answer draws on document excerpts above, cite them inline using their label (e.g. [F1]). This is separate from any [N] web-source citations you are also instructed to use elsewhere — use both where appropriate, and do not invent any other citation format.'
  }
  console.log(`  [memory] injecting ${lines.length}/${allMemories.length} memories (${ranked === rest ? 'by recency' : 'by relevance'}) + ${ragInjected} RAG + ${fileSources.length} file sources (~${estimateTokens(block)} tokens) for space ${spaceId.slice(0, 8)}`)
  return { block, fileSources }
}

// --- User-level memory ---
//
// Facts that hold across every chat, space or not. Deliberately narrower than space memory:
// written only by hand or by an explicit tool call, never by automatic extraction. The asymmetry
// is the reason — a wrong space memory is wrong in one space, a wrong user memory is wrong in
// every future conversation.

/** Join the user block ahead of the space/file block, skipping empties. */
export function joinMemoryBlocks(...blocks: string[]): string {
  return blocks.filter(b => b.trim()).join('\n\n')
}
