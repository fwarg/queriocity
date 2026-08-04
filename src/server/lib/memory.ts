import { generateText } from 'ai'
import { randomUUID } from 'crypto'
import { db, spaceMemories, userMemories, chatSessions, messages, spaces, monitorRuns, sqlite, getAppSetting, setAppSetting } from './db.ts'
import { eq, desc, asc, ne, and, or, gt, isNull } from 'drizzle-orm'
import { getSmallModel, getChatModel, getThinkingModelOrFallback } from './llm.ts'
import { embedText, embedTexts } from './embeddings.ts'
import { searchSpaceFiles, searchUploads, spaceHasTaggedFiles, type ChunkResult } from './files/uploads-search.ts'
import { rerank, rerankEnabled } from './reranker.ts'

export interface SpaceMemory {
  id: string
  spaceId: string
  content: string
  source: 'tool' | 'extraction' | 'manual'
  sessionId: string | null
  createdAt: Date
  updatedAt: Date
}

/** Build a file RAG block for non-space chats from the user's own uploaded files. */
export async function buildChatFileBlock(
  userId: string,
  query: string,
  ragBudget = 500,
): Promise<MemoryBlock> {
  if (!query.trim() || ragBudget <= 0) return { block: '', fileSources: [] }

  let fileRows: ChunkResult[] = []
  try {
    fileRows = await searchUploads(query, userId, 15)
  } catch (e) {
    console.error('  [memory] chat file RAG failed:', e)
    return { block: '', fileSources: [] }
  }

  if (!fileRows.length) return { block: '', fileSources: [] }

  const citedFiles = new Map<string, { filename: string; label: string }>()
  let fileCounter = 0
  let ragRemaining = ragBudget
  const fileLines: string[] = []

  for (const chunk of fileRows) {
    const cost = Math.ceil(chunk.content.length / 4)
    if (cost > ragRemaining) continue
    ragRemaining -= cost
    if (!citedFiles.has(chunk.fileId)) {
      citedFiles.set(chunk.fileId, { filename: chunk.filename, label: `F${++fileCounter}` })
    }
    const { label } = citedFiles.get(chunk.fileId)!
    fileLines.push(`[${label}] ${chunk.content}`)
    console.log(`    [rag:chat-file] ${chunk.content.length} chars: ${JSON.stringify(chunk.content.slice(0, 60))}`)
    if (ragRemaining <= 0) break
  }

  if (!fileLines.length) return { block: '', fileSources: [] }

  const fileSources = Array.from(citedFiles.entries())
    .map(([fileId, { filename, label }]) => ({ title: `[${label}] ${filename}`, url: `file:${fileId}` }))

  let block = '## Relevant document excerpts\n' + fileLines.map(l => `> ${l}`).join('\n\n')
  block += '\n\nWhen your answer draws on document excerpts above, cite them inline using their label (e.g. [F1]). Do not add other citation formats.'

  console.log(`  [memory] chat file RAG: ${fileLines.length} chunks, ${fileSources.length} files (~${Math.ceil(block.length / 4)} tokens)`)
  return { block, fileSources }
}

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
  k = 8,
  excludeSessionId?: string,
): Promise<HistoryHit[]> {
  if (!query.trim()) return []
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
    `).all(JSON.stringify(embedding), k, spaceId, excludeSessionId ?? null) as
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

/** Load all memories for a space, newest first. */
export async function getSpaceMemories(spaceId: string) {
  return db.select().from(spaceMemories)
    .where(eq(spaceMemories.spaceId, spaceId))
    .orderBy(desc(spaceMemories.createdAt))
}

// --- Memory embeddings (relevance-ranked recall) ---

/** Store/replace the vector for one memory. Never throws: an embedding failure must not lose the
 *  memory itself, and `backfillMemoryEmbeddings` retries on the next read. */
export async function embedMemory(memoryId: string, content: string): Promise<void> {
  try {
    const embedding = await embedText(content)
    sqlite.run('DELETE FROM memory_embeddings WHERE memory_id = ?', [memoryId])
    sqlite.run('INSERT INTO memory_embeddings(memory_id, embedding) VALUES (?,?)',
      [memoryId, JSON.stringify(embedding)])
  } catch (e) {
    console.error(`  [memory] embed failed for ${memoryId.slice(0, 8)}:`, e)
  }
}

export function deleteMemoryEmbeddings(memoryIds: string[]): void {
  if (!memoryIds.length) return
  const stmt = sqlite.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?')
  sqlite.transaction(() => { for (const id of memoryIds) stmt.run(id) })()
}

/** Embed any memories that have no vector yet, in one batch. Self-healing: covers databases that
 *  predate this table, rows written while the embedder was down, and dimension changes. */
async function backfillMemoryEmbeddings(memories: Array<{ id: string; content: string }>): Promise<void> {
  if (!memories.length) return
  const placeholders = memories.map(() => '?').join(',')
  const present = new Set((sqlite.prepare(
    `SELECT memory_id FROM memory_embeddings WHERE memory_id IN (${placeholders})`
  ).all(...memories.map(m => m.id)) as Array<{ memory_id: string }>).map(r => r.memory_id))

  const missing = memories.filter(m => !present.has(m.id))
  if (!missing.length) return
  try {
    const vectors = await embedTexts(missing.map(m => m.content))
    const stmt = sqlite.prepare('INSERT INTO memory_embeddings(memory_id, embedding) VALUES (?,?)')
    sqlite.transaction(() => {
      for (let i = 0; i < missing.length; i++) stmt.run(missing[i].id, JSON.stringify(vectors[i]))
    })()
    console.log(`  [memory] backfilled ${missing.length} memory embeddings`)
  } catch (e) {
    console.error('  [memory] embedding backfill failed:', e)
  }
}

/** Ids of the given memories ordered by distance from `embedding`, nearest first.
 *
 *  The `memory_id IN (...)` constraint is pushed down into the vector index, so `k` means "k
 *  nearest *within this set*". That distinction matters: sqlite-vec applies `k` before ordinary
 *  JOIN predicates, so scoping by joining another table instead would ask for the k nearest rows
 *  in the whole table and keep whichever survived the filter — frequently none. */
function nearestMemoryIds(embedding: number[], scopeIds: string[], limit?: number): string[] {
  if (!scopeIds.length) return []
  const placeholders = scopeIds.map(() => '?').join(',')
  const rows = sqlite.prepare(`
    SELECT memory_id
    FROM memory_embeddings
    WHERE embedding MATCH ? AND memory_id IN (${placeholders}) AND k = ?
    ORDER BY distance
  `).all(JSON.stringify(embedding), ...scopeIds, limit ?? scopeIds.length) as Array<{ memory_id: string }>
  return rows.map(r => r.memory_id)
}

/** Order the given memories by relevance to the query, best first.
 *  Returns null when ranking is unavailable, so the caller can fall back to recency. */
async function rankMemoriesByRelevance<T extends { id: string; content: string }>(
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

  if (rerankEnabled && ordered.length > 1) {
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
  const cost = (m: T) => Math.ceil(`- ${m.content}`.length / 4)
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
  fileSources: Array<{ title: string; url: string }>
}

/** Build a formatted memory block for system prompt injection, with optional RAG layer. */
export async function buildMemoryBlock(
  spaceId: string,
  tokenBudget = 1000,
  ragBudget = 0,
  query?: string,
  includeFileIds?: string[],
  includeMemoryIds?: string[],
): Promise<MemoryBlock> {
  const allMemories = await getSpaceMemories(spaceId)
  if (!allMemories.length) return { block: '', fileSources: [] }

  const header = '## Space Memory\nThe following facts were accumulated from previous conversations in this space. Use them to inform your responses.'
  const headerTokens = Math.ceil(header.length / 4)

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
      let chatRows: Array<{ chunk_id: string; content: string }> = []
      try {
        // Space scoping via pushed-down IN rather than a JOIN predicate — with `AND cs.space_id`
        // outside, `k = 15` means "15 nearest chunks anywhere", and a busy neighbouring space
        // leaves this one with nothing. See the note on searchSpaceFiles.
        chatRows = sqlite.prepare(`
          SELECT ccm.chunk_id, ccm.content
          FROM chat_chunks cc
          JOIN chat_chunk_meta ccm ON ccm.chunk_id = cc.chunk_id
          WHERE cc.embedding MATCH ?
            AND k = 15
            AND cc.chunk_id IN (
              SELECT m2.chunk_id FROM chat_chunk_meta m2
              JOIN chat_sessions s2 ON s2.id = m2.session_id
              WHERE s2.space_id = ?
            )
          ORDER BY cc.distance
        `).all(JSON.stringify(embedding), spaceId) as Array<{ chunk_id: string; content: string }>
      } catch (e) {
        console.error('  [memory] chat RAG search failed:', e)
      }

      let fileRows: ChunkResult[] = []
      if (hasTaggedFiles) {
        try {
          fileRows = await searchSpaceFiles(spaceId, query, embedding, 15, true, includeFileIds)
        } catch (e) {
          console.error('  [memory] space file RAG failed:', e)
        }
      }

      const labelFileChunk = (fileId: string, filename: string, content: string): string => {
        if (!citedFiles.has(fileId)) {
          citedFiles.set(fileId, { filename, label: `F${++fileCounter}` })
        }
        const { label } = citedFiles.get(fileId)!
        return `[${label}] ${content}`
      }

      if (rerankEnabled && (chatRows.length + fileRows.length) > 0) {
        // Joint rerank: cross-encoder scores let chat and file chunks compete fairly
        console.log(`  [rag:rerank] joint reranking ${chatRows.length} chat + ${fileRows.length} file candidates`)
        const combined = [
          ...chatRows.map(r => ({ content: r.content, source: 'chat' as const, fileId: '', filename: '' })),
          ...fileRows.map(r => ({ content: r.content, source: 'file' as const, fileId: r.fileId, filename: r.filename })),
        ]
        const indices = await rerank(query, combined.map(r => r.content), combined.length)
        const chatLines: string[] = []
        const fileLines: string[] = []
        for (const idx of indices) {
          const item = combined[idx]
          const cost = Math.ceil(item.content.length / 4)
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
          const cost = Math.ceil(row.content.length / 4)
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
            const cost = Math.ceil(chunk.content.length / 4)
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
    .map(([fileId, { filename, label }]) => ({ title: `[${label}] ${filename}`, url: `file:${fileId}` }))
  if (fileSources.length > 0) {
    block += '\n\nWhen your answer draws on document excerpts above, cite them inline using their label (e.g. [F1]). Do not add other citation formats.'
  }
  console.log(`  [memory] injecting ${lines.length}/${allMemories.length} memories (${ranked === rest ? 'by recency' : 'by relevance'}) + ${ragInjected} RAG + ${fileSources.length} file sources (~${Math.ceil(block.length / 4)} tokens) for space ${spaceId.slice(0, 8)}`)
  return { block, fileSources }
}

// --- User-level memory ---
//
// Facts that hold across every chat, space or not. Deliberately narrower than space memory:
// written only by hand or by an explicit tool call, never by automatic extraction. The asymmetry
// is the reason — a wrong space memory is wrong in one space, a wrong user memory is wrong in
// every future conversation.

export async function getUserMemories(userId: string) {
  return db.select().from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(desc(userMemories.createdAt))
}

/** Store a user-level fact, skipping exact restatements of one already held. */
export async function saveUserMemory(
  userId: string,
  content: string,
  source: 'tool' | 'manual',
): Promise<string> {
  const trimmed = content.trim()
  if (!trimmed) return ''

  // Only the model-written path is screened. What the user types by hand is their own decision;
  // what the model decides to file away about them, into a profile attached to every future
  // prompt, is not — and an address or key there is a leak, not a preference.
  if (source === 'tool' && isSensitiveFact(trimmed)) {
    console.warn(`  [memory] refused user memory containing an identifier: "${trimmed.slice(0, 40)}…"`)
    return ''
  }

  const existing = await getUserMemories(userId)
  for (const m of existing) {
    if (m.content.includes(trimmed)) return m.id
    if (trimmed.includes(m.content)) {
      await db.update(userMemories).set({ content: trimmed, updatedAt: new Date() })
        .where(eq(userMemories.id, m.id))
      await embedMemory(m.id, trimmed)
      return m.id
    }
  }

  const id = randomUUID()
  const now = new Date()
  await db.insert(userMemories).values({ id, userId, content: trimmed, source, createdAt: now, updatedAt: now })
  await embedMemory(id, trimmed)
  console.log(`  [memory] saved user memory (${source}): "${trimmed.slice(0, 60)}"`)
  return id
}

export async function deleteUserMemory(userId: string, id: string): Promise<boolean> {
  const row = await db.select().from(userMemories)
    .where(and(eq(userMemories.id, id), eq(userMemories.userId, userId))).get()
  if (!row) return false
  await db.delete(userMemories).where(eq(userMemories.id, id))
  deleteMemoryEmbeddings([id])
  return true
}

/** Build the `## About the user` block. Placed before the space block by callers, and says so,
 *  because the space is the more specific context when the two disagree. */
export async function buildUserMemoryBlock(
  userId: string,
  tokenBudget: number,
  query?: string,
): Promise<string> {
  if (tokenBudget <= 0) return ''
  const all = await getUserMemories(userId)
  if (!all.length) return ''

  const header = '## About the user\nStable facts about the user that apply to every conversation. Where these conflict with space-specific memory below, prefer the space.'
  const guaranteed = all.filter(m => m.alwaysKeep)
  const rest = all.filter(m => !m.alwaysKeep)

  let ranked = rest
  if (query?.trim() && rest.length) {
    try {
      ranked = (await rankMemoriesByRelevance(rest, query, await embedText(query))) ?? rest
    } catch (e) {
      console.error('  [memory] user memory ranking failed:', e)
    }
  }

  const { chosen } = selectMemories(guaranteed, ranked, tokenBudget - Math.ceil(header.length / 4))
  if (!chosen.length) return ''
  console.log(`  [memory] injecting ${chosen.length}/${all.length} user memories`)
  return header + '\n' + chosen.map(m => `- ${m.content}`).join('\n')
}

/** Cap on how many recent sessions a suggestion scan reads. One model call each, and this runs
 *  interactively, so the ceiling is on wall-clock patience rather than correctness. */
const SUGGEST_SESSION_LIMIT = 20
/** Hard ceiling regardless of what the caller asks for: the scan is one model call per session
 *  and runs while the user waits, so this bounds a request that would otherwise be unbounded. */
const SUGGEST_SESSION_MAX = 200
/** More chats scanned means more distinct facts worth showing, but the list still has to be
 *  reviewed by hand — so it grows with the scan and then stops. */
const suggestResultCap = (sessions: number) => Math.min(25, Math.max(10, Math.round(sessions / 4)))
/** Per-message cap applied before the conversation is assembled. A user message can carry an
 *  inlined attachment — hundreds of thousands of characters — and without this one document
 *  crowds out every actual exchange, so the scan ends up describing the document, not the person.
 *  Truncating the head of each message also keeps what the user typed, which precedes any
 *  attached payload. */
const SUGGEST_MESSAGE_CHARS = 1200
const SUGGEST_CONVERSATION_CHARS = 6000

/** Contact details, credentials and identifiers must never reach a profile that is injected into
 *  every future prompt: it is data the user never asked to publish, and it is useless as a
 *  preference. Cheap and deterministic, so it does not depend on the model obeying the prompt. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.]+/,           // email address
  /\+?\d[\d\s().-]{7,}\d/,             // phone number / long digit run
  /\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{8,}/i, // common API-key shapes
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,      // base64-ish blobs (tokens, hashes)
]

export function isSensitiveFact(fact: string): boolean {
  return SENSITIVE_PATTERNS.some(re => re.test(fact))
}

/** Propose user-level facts from the user's own recent chats. Returns candidates only — nothing
 *  is stored. Automatic extraction into a global profile is deliberately not done (a wrong fact
 *  would then apply to every future conversation); this is the reviewed version of it. */
export async function suggestUserMemories(
  userId: string,
  sessionLimit: number = SUGGEST_SESSION_LIMIT,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const limit = Math.min(SUGGEST_SESSION_MAX, Math.max(1, Math.floor(sessionLimit) || SUGGEST_SESSION_LIMIT))
  // Monitor-run sessions are excluded on the same rule the chat list uses: they are scheduled
  // queries, not conversations the user had, and their recurring prompt is instruction-shaped
  // ("report on X, be concise, cite sources") — read as a profile it yields the assistant's
  // standing orders rather than anything about the person.
  const sessions = await db.select({ id: chatSessions.id })
    .from(chatSessions)
    .leftJoin(monitorRuns, eq(chatSessions.id, monitorRuns.sessionId))
    .where(and(
      eq(chatSessions.userId, userId),
      or(isNull(monitorRuns.id), eq(chatSessions.graduated, 1)),
    ))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(limit)

  const maxResults = suggestResultCap(sessions.length)
  const existing = (await getUserMemories(userId)).map(m => m.content)
  const found: string[] = []

  for (let i = 0; i < sessions.length; i++) {
    onProgress?.(i + 1, sessions.length)
    const msgs = await db.select().from(messages).where(eq(messages.sessionId, sessions[i].id))
    if (!msgs.length) continue
    const conversation = msgs
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, SUGGEST_MESSAGE_CHARS)}`)
      .join('\n\n')
    try {
      const result = await generateText({
        model: getSmallModel(),
        // Deliberately narrower than extractMemoriesPostHoc, which also captures topical research
        // findings. Those belong to a space; only durable traits about the person belong here.
        system: `Identify durable facts about the USER that would still be true in an unrelated future conversation: how they want answers written, languages they work in, their role or expertise, lasting tools and constraints they have committed to.

Report only what the person is or prefers. In particular, do NOT report:
- instructions addressed to the assistant, or anything phrased as a task, template or prompt — those describe a request, not the person
- the subject matter of the conversation, or anything about the assistant itself
- contact details, addresses, account names, keys or any other personal identifier
- pasted or attached document content, which describes the document rather than its reader
- anything true only today

If nothing qualifies, output "NONE". Otherwise output one fact per line prefixed with "- ", each a complete sentence about the user.`,
        prompt: conversation.slice(0, SUGGEST_CONVERSATION_CHARS),
        maxOutputTokens: 200,
      })
      found.push(...result.text.split('\n')
        .map(l => l.replace(/^-\s*/, '').trim())
        .filter(l => l && l !== 'NONE' && l.length > 10 && l.length < 300))
    } catch (e) {
      console.error(`  [memory] suggestion scan failed for session ${sessions[i].id.slice(0, 8)}:`, e)
    }
  }

  // Drop anything already known, and near-identical repeats across sessions.
  const seen = new Set<string>()
  const suggestions: string[] = []
  let redacted = 0
  for (const fact of found) {
    // Belt and braces with the prompt rule above: the model is asked not to surface identifiers,
    // and anything that slips through is dropped here rather than offered for one careless click.
    if (isSensitiveFact(fact)) { redacted++; continue }
    const key = fact.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    if (seen.has(key)) continue
    seen.add(key)
    if (existing.some(e => e.toLowerCase().includes(key) || key.includes(e.toLowerCase()))) continue
    suggestions.push(fact)
    if (suggestions.length >= maxResults) break
  }
  console.log(`  [memory] suggested ${suggestions.length} user memories from ${sessions.length} sessions${redacted ? ` (${redacted} dropped as identifying)` : ''}`)
  return suggestions
}

/** The user block, or '' when the user has not opted in. Centralises the gate so no call site can
 *  accidentally inject it for someone who left the setting off. */
export async function userMemoryBlockIfEnabled(
  userId: string,
  settings: Record<string, unknown>,
  query?: string,
): Promise<string> {
  if (settings.userMemory !== true) return ''
  const budget = await getAppSetting('user_memory_token_budget', '300').then(Number)
  return buildUserMemoryBlock(userId, budget, query)
}

/** Join the user block ahead of the space/file block, skipping empties. */
export function joinMemoryBlocks(...blocks: string[]): string {
  return blocks.filter(b => b.trim()).join('\n\n')
}

// --- Write-time conflict resolution ---

type MemoryRow = Awaited<ReturnType<typeof getSpaceMemories>>[number]

interface MemoryWrite {
  /** UPDATE rewrites `targetId` in place; DELETE removes it and adds the new fact separately. */
  op: 'ADD' | 'UPDATE' | 'NOOP'
  fact: string
  targetId?: string
}

/** The existing memories a new fact might duplicate or contradict — its nearest neighbours. */
async function conflictCandidates(existing: MemoryRow[], facts: string[]): Promise<MemoryRow[]> {
  if (!existing.length) return []
  await backfillMemoryEmbeddings(existing)
  const byId = new Map(existing.map(m => [m.id, m]))
  const scope = existing.map(m => m.id)
  const picked = new Set<string>()
  try {
    const embeddings = await embedTexts(facts)
    for (const embedding of embeddings) {
      for (const id of nearestMemoryIds(embedding, scope, 5)) picked.add(id)
    }
  } catch (e) {
    console.error('  [memory] conflict candidate lookup failed:', e)
    return []
  }
  return [...picked].map(id => byId.get(id)!).filter(Boolean)
}

/** Ask the small model whether each fact is new, an update of an existing memory, or redundant.
 *  On any failure every fact falls back to ADD — a duplicate is recoverable, a lost fact is not. */
async function planMemoryWrites(facts: string[], candidates: MemoryRow[]): Promise<MemoryWrite[]> {
  const fallback: MemoryWrite[] = facts.map(fact => ({ op: 'ADD', fact }))
  if (!candidates.length) return fallback

  const existingList = candidates.map((m, i) => `[${i}] ${m.content}`).join('\n')
  const newList = facts.map((f, i) => `(${i}) ${f}`).join('\n')
  try {
    const result = await generateText({
      model: getSmallModel(),
      system: `You maintain a user's long-term memory. For each NEW fact decide exactly one action:
- ADD: genuinely new information.
- UPDATE: it supersedes an EXISTING memory (same subject, changed or more specific value). Give the existing index.
- NOOP: already covered by an existing memory; adds nothing.
Prefer ADD when unsure. Never merge unrelated subjects.
Respond with ONLY a JSON array, one object per new fact, in order:
[{"i":0,"op":"ADD"},{"i":1,"op":"UPDATE","target":3},{"i":2,"op":"NOOP"}]`,
      prompt: `EXISTING MEMORIES:\n${existingList}\n\nNEW FACTS:\n${newList}`,
      maxOutputTokens: 400,
    })
    const json = result.text.replace(/```(?:json)?/g, '').trim()
    const start = json.indexOf('[')
    const parsed = JSON.parse(json.slice(start, json.lastIndexOf(']') + 1)) as
      Array<{ i: number; op: string; target?: number }>

    const writes = [...fallback]
    for (const d of parsed) {
      if (typeof d.i !== 'number' || !writes[d.i]) continue
      const target = typeof d.target === 'number' ? candidates[d.target] : undefined
      // The user's own words are never overwritten or discarded by the model; downgrade to ADD
      // so the new fact is still kept and the two can be reconciled by a human or the dream.
      const locked = target && (target.source === 'manual' || target.alwaysKeep)
      if (d.op === 'UPDATE' && target && !locked) writes[d.i] = { op: 'UPDATE', fact: writes[d.i].fact, targetId: target.id }
      else if (d.op === 'NOOP' && !locked) writes[d.i] = { op: 'NOOP', fact: writes[d.i].fact }
    }
    return writes
  } catch (e) {
    console.error('  [memory] write planning failed, adding all facts:', e)
    return fallback
  }
}

/** Save several extracted facts in one pass — one planning call for the batch, not one per fact. */
export async function saveMemories(
  spaceId: string,
  facts: string[],
  source: 'tool' | 'extraction' | 'manual',
  sessionId?: string,
): Promise<void> {
  const trimmed = facts.map(f => f.trim()).filter(Boolean)
  if (!trimmed.length) return

  const existing = await db.select().from(spaceMemories).where(eq(spaceMemories.spaceId, spaceId))
  // Exact containment is settled without troubling the model.
  const novel = trimmed.filter(f => !existing.some(m => m.content.includes(f)))
  if (!novel.length) return

  const candidates = await conflictCandidates(existing, novel)
  const writes = await planMemoryWrites(novel, candidates)

  let added = 0, updated = 0, skipped = 0
  for (const w of writes) {
    if (w.op === 'NOOP') { skipped++; continue }
    if (w.op === 'UPDATE' && w.targetId) {
      await db.update(spaceMemories).set({ content: w.fact, updatedAt: new Date() })
        .where(eq(spaceMemories.id, w.targetId))
      await embedMemory(w.targetId, w.fact)
      updated++
      continue
    }
    await saveMemory(spaceId, w.fact, source, sessionId)
    added++
  }
  console.log(`  [memory] saved ${added} added, ${updated} updated, ${skipped} redundant (${candidates.length} candidates considered)`)
}

/** Save a memory with basic dedup (exact substring match). */
export async function saveMemory(
  spaceId: string,
  content: string,
  source: 'tool' | 'extraction' | 'manual',
  sessionId?: string,
): Promise<string> {
  const trimmed = content.trim()
  if (!trimmed) return ''

  const existing = await db.select().from(spaceMemories)
    .where(eq(spaceMemories.spaceId, spaceId))

  for (const m of existing) {
    if (m.content.includes(trimmed)) return m.id // existing is more detailed
    if (trimmed.includes(m.content)) {
      // new content is more detailed — replace
      const now = new Date()
      await db.update(spaceMemories).set({ content: trimmed, updatedAt: now })
        .where(eq(spaceMemories.id, m.id))
      await embedMemory(m.id, trimmed)
      return m.id
    }
  }

  const id = randomUUID()
  const now = new Date()
  await db.insert(spaceMemories).values({
    id, spaceId, content: trimmed, source,
    // Provenance only, and best-effort: space_memories.session_id is a FK to chat_sessions,
    // but the session row is not written until persistMessage runs *after* generation. The
    // save_to_memory tool fires *during* it, so on the first turn of a new chat the id does
    // not exist yet and the insert would fail — silently losing the memory the model chose to
    // keep. Losing the link is acceptable; losing the fact is not.
    sessionId: sessionId && sessionExists(sessionId) ? sessionId : null,
    createdAt: now, updatedAt: now,
  })
  await embedMemory(id, trimmed)
  return id
}

/** Whether a chat session row exists yet — see the FK note in saveMemory. */
function sessionExists(sessionId: string): boolean {
  const row = sqlite.prepare('SELECT 1 FROM chat_sessions WHERE id = ?').get(sessionId)
  return row != null
}

/** Extract memories from a completed chat using the small model. */
export async function extractMemoriesPostHoc(
  spaceId: string,
  sessionId: string,
  userContent: string,
  assistantContent: string,
): Promise<void> {
  if (!userContent.trim()) return
  const t0 = performance.now()

  const maxChars = parseInt(await getAppSetting('memory_extract_chars', '6000'))
  const combined = `User: ${userContent}\n\nAssistant: ${assistantContent}`
  const result = await generateText({
    model: getSmallModel(),
    system: `Extract noteworthy facts, preferences, or decisions from this conversation that would be useful to remember for future conversations. Output one fact per line, prefixed with "- ". Only extract genuinely useful long-term facts, not ephemeral details. If there are no noteworthy facts, output "NONE".`,
    prompt: combined.slice(-maxChars),
    maxOutputTokens: 300,
  })

  const lines = result.text.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l && l !== 'NONE' && l.length > 5 && l.length < 300)

  // One planning call for the whole batch: routing each fact through saveMemory individually
  // would cost an extra small-model round-trip per fact on every turn.
  await saveMemories(spaceId, lines, 'extraction', sessionId)
  console.log(`  [memory] post-hoc extracted ${lines.length} facts in ${Math.round(performance.now() - t0)}ms (small model)`)
}

/**
 * Compact all memories for a space using the small LLM.
 * Merges near-duplicates and removes redundant entries.
 * No-ops if totalTokens <= triggerTokens (defaults to targetTokens for manual use).
 */
export async function compactSpaceMemories(
  spaceId: string,
  targetTokens: number,
  triggerTokens = targetTokens,
): Promise<boolean> {
  const allMemories = await getSpaceMemories(spaceId)
  // Always-keep entries are exempt: the user asked for them verbatim, so they are neither fed to
  // the compactor nor deleted by it. They still count towards the trigger threshold.
  const kept = allMemories.filter(m => m.alwaysKeep)
  const memories = allMemories.filter(m => !m.alwaysKeep)
  if (memories.length < 2) return false

  const totalTokens = allMemories.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)
  if (totalTokens <= triggerTokens) return false

  const t0 = performance.now()
  const input = memories.map(m => `- ${m.content}`).join('\n')

  const result = await generateText({
    model: getSmallModel(),
    system: `You are a memory compactor. Given a list of facts from a user's space memory:
1. Merge near-duplicate or redundant facts into one
2. Remove facts that are subsets of others
3. Preserve all unique information
Output ONLY the final list, one fact per line, prefixed with "- ". No other text. No preamble.
Target: approximately ${targetTokens * 4} characters total.`,
    prompt: input,
    maxOutputTokens: targetTokens,
  })

  const newFacts = result.text.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 5 && l.length < 500)

  if (!newFacts.length) {
    console.log(`  [compact] aborted — LLM returned no facts for space ${spaceId.slice(0, 8)}`)
    return false
  }

  const now = new Date()
  const newMemories: Array<{ id: string; content: string }> = newFacts.map(content => ({ id: randomUUID(), content }))
  await db.transaction(async tx => {
    await tx.delete(spaceMemories).where(
      and(eq(spaceMemories.spaceId, spaceId), eq(spaceMemories.alwaysKeep, false)),
    )
    for (const { id, content } of newMemories) {
      await tx.insert(spaceMemories).values({
        id, spaceId, content, source: 'compact',
        sessionId: null, createdAt: now, updatedAt: now,
      })
    }
  })
  deleteMemoryEmbeddings(memories.map(m => m.id))
  await backfillMemoryEmbeddings(newMemories)
  console.log(`  [compact] ${memories.length} → ${newFacts.length} memories${kept.length ? ` (+${kept.length} always-keep)` : ''} in ${Math.round(performance.now() - t0)}ms for space ${spaceId.slice(0, 8)}`)
  return true
}

/**
 * Deep-dream compaction: re-extracts from source conversations using the thinking model,
 * then synthesises with contradiction resolution and pattern inference.
 * Preserves manual memories. Falls back to regular compact if no sessions found.
 */
export async function deepDreamSpace(
  spaceId: string,
  targetTokens: number,
): Promise<boolean> {
  const existing = await getSpaceMemories(spaceId)
  const t0 = performance.now()

  // Stage 1: re-extract from source conversations (oldest first for recency ordering in synthesis)
  const sessions = await db.select()
    .from(chatSessions)
    .where(eq(chatSessions.spaceId, spaceId))
    .orderBy(asc(chatSessions.createdAt))

  const allExtracted: string[] = []
  for (const session of sessions) {
    const msgs = await db.select()
      .from(messages)
      .where(eq(messages.sessionId, session.id))
    if (!msgs.length) continue
    const conversation = msgs.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
    const result = await generateText({
      model: getChatModel(),
      system: `Extract long-term valuable facts from this conversation. Include both:
- User context: preferences, decisions, constraints, recurring interests
- Research findings: key facts, conclusions, standards, tools, or sources surfaced by the assistant that would be useful to recall in future conversations on this topic
Output one fact per line prefixed with "- ". Be specific — capture the actual finding, not just the topic. Skip ephemeral details. If nothing worth keeping: output "NONE".`,
      prompt: conversation,
    })
    const facts = result.text.split('\n')
      .map(l => l.replace(/^-\s*/, '').trim())
      .filter(l => l && l !== 'NONE' && l.length > 5 && l.length < 300)
    allExtracted.push(...facts)
  }

  // Include manual and always-keep memories as seeds (they survive regardless)
  const manualMemories = existing.filter(m => m.source === 'manual' || m.alwaysKeep)
  const manualLines = manualMemories.map(m => `- ${m.content}`)
  const extractedLines = allExtracted.map(f => `- ${f}`)

  if (!extractedLines.length && !manualLines.length) {
    console.log(`  [deep-dream] nothing to synthesise for space ${spaceId.slice(0, 8)}, skipping`)
    return false
  }

  // Stage 2: synthesis — resolve contradictions, merge, infer patterns
  const inputLines = [...extractedLines, ...manualLines].join('\n')
  const targetChars = targetTokens * 4

  const synthesis = await generateText({
    model: getThinkingModelOrFallback(),
    system: `You are consolidating a space memory from multiple conversations.
Facts are listed oldest-first. When facts conflict, prefer the newer one.

Tasks:
1. Merge near-duplicates into the more specific/recent version
2. Remove facts that are fully covered by another
3. If the same topic recurs across many facts, synthesize a general preference
4. Preserve all unique constraints, decisions, and preferences

Output ONLY the final fact list, one per line, prefixed with "- ".
Be ruthless: if in doubt, cut. Total output MUST NOT exceed ${targetChars} characters.`,
    prompt: inputLines,
  })

  const newFacts = synthesis.text.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 5 && l.length < 500)

  if (!newFacts.length) {
    console.log(`  [deep-dream] synthesis returned no facts for space ${spaceId.slice(0, 8)}`)
    return false
  }

  // Replace everything except manual and always-keep memories, which survive untouched
  const now = new Date()
  const replaced = existing.filter(m => m.source !== 'manual' && !m.alwaysKeep)
  const newMemories = newFacts.map(content => ({ id: randomUUID(), content }))
  await db.transaction(async tx => {
    await tx.delete(spaceMemories).where(and(
      eq(spaceMemories.spaceId, spaceId),
      ne(spaceMemories.source, 'manual'),
      eq(spaceMemories.alwaysKeep, false),
    ))
    for (const { id, content } of newMemories) {
      await tx.insert(spaceMemories).values({
        id, spaceId, content, source: 'compact',
        sessionId: null, createdAt: now, updatedAt: now,
      })
    }
  })
  deleteMemoryEmbeddings(replaced.map(m => m.id))
  await backfillMemoryEmbeddings(newMemories)

  console.log(`  [deep-dream] ${existing.length} → ${newFacts.length + manualMemories.length} memories in ${Math.round(performance.now() - t0)}ms for space ${spaceId.slice(0, 8)}`)

  // Stage 3: compression guard — if still over budget run a final compact
  const newTotal = newFacts.reduce((n, f) => n + Math.ceil(f.length / 4), 0)
  if (newTotal > targetTokens) {
    await compactSpaceMemories(spaceId, targetTokens)
  }

  return true
}

export async function runDream() {
  const [threshold, target, deep] = await Promise.all([
    getAppSetting('dream_threshold', '1500').then(Number),
    getAppSetting('dream_target', '700').then(Number),
    getAppSetting('dream_deep', 'false').then(v => v === 'true'),
  ])
  const allSpaces = await db.select({ id: spaces.id }).from(spaces)
  console.log(`  [dream] checking ${allSpaces.length} spaces (threshold=${threshold}, target=${target}, deep=${deep})`)
  for (const sp of allSpaces) {
    if (deep) {
      const key = `deep_dream_at_${sp.id}`
      const lastRunAt = new Date(parseInt(await getAppSetting(key, '0')))
      const hasNew = await db.select({ id: chatSessions.id })
        .from(chatSessions)
        .where(and(eq(chatSessions.spaceId, sp.id), gt(chatSessions.createdAt, lastRunAt)))
        .limit(1)
      if (hasNew.length > 0) {
        const ran = await deepDreamSpace(sp.id, target)
        if (ran) await setAppSetting(key, String(Date.now()))
      }
    } else {
      await compactSpaceMemories(sp.id, target, threshold)
    }
  }
  console.log(`  [dream] done`)
}
