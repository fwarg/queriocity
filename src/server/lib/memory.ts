import { generateText } from 'ai'
import { randomUUID } from 'crypto'
import { db, spaceMemories, chatSessions, messages, spaces, sqlite, getAppSetting, setAppSetting } from './db.ts'
import { eq, desc, asc, ne, and, gt } from 'drizzle-orm'
import { getSmallModel, getThinkingModelOrFallback } from './llm.ts'
import { embedText } from './embeddings.ts'
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

/** Load all memories for a space, newest first. */
export async function getSpaceMemories(spaceId: string) {
  return db.select().from(spaceMemories)
    .where(eq(spaceMemories.spaceId, spaceId))
    .orderBy(desc(spaceMemories.createdAt))
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
): Promise<MemoryBlock> {
  const memories = await getSpaceMemories(spaceId)
  if (!memories.length) return { block: '', fileSources: [] }

  const header = '## Space Memory\nThe following facts were accumulated from previous conversations in this space. Use them to inform your responses.'
  const headerTokens = Math.ceil(header.length / 4)
  let remaining = tokenBudget - headerTokens
  const lines: string[] = []

  for (const m of memories) {
    const line = `- ${m.content}`
    const cost = Math.ceil(line.length / 4)
    if (cost > remaining) break
    remaining -= cost
    lines.push(line)
  }

  if (!lines.length) return { block: '', fileSources: [] }
  let block = header + '\n' + lines.join('\n')
  let ragInjected = 0
  const citedFiles = new Map<string, { filename: string; label: string }>()
  let fileCounter = 0

  if (ragBudget > 0 && query?.trim()) {
    let ragRemaining = ragBudget
    const hasTaggedFiles = spaceHasTaggedFiles(spaceId)

    // Embed query once — reused for both memory RAG and file RAG
    let embedding: number[] | null = null
    try {
      embedding = await embedText(query)
    } catch (e) {
      console.error('  [memory] RAG embed failed:', e)
    }

    if (embedding) {
      // Fetch candidates from both sources
      let chatRows: Array<{ chunk_id: string; content: string }> = []
      try {
        chatRows = sqlite.prepare(`
          SELECT ccm.chunk_id, ccm.content
          FROM chat_chunks cc
          JOIN chat_chunk_meta ccm ON ccm.chunk_id = cc.chunk_id
          JOIN chat_sessions cs ON cs.id = ccm.session_id
          WHERE cc.embedding MATCH ?
            AND cs.space_id = ?
            AND k = 15
          ORDER BY cc.distance
        `).all(JSON.stringify(embedding), spaceId) as Array<{ chunk_id: string; content: string }>
      } catch (e) {
        console.error('  [memory] chat RAG search failed:', e)
      }

      let fileRows: ChunkResult[] = []
      if (hasTaggedFiles) {
        try {
          fileRows = await searchSpaceFiles(spaceId, query, embedding, 15, true)
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
  console.log(`  [memory] injecting ${lines.length} memories + ${ragInjected} RAG + ${fileSources.length} file sources (~${Math.ceil(block.length / 4)} tokens) for space ${spaceId.slice(0, 8)}`)
  return { block, fileSources }
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
      return m.id
    }
  }

  const id = randomUUID()
  const now = new Date()
  await db.insert(spaceMemories).values({
    id, spaceId, content: trimmed, source,
    sessionId: sessionId ?? null,
    createdAt: now, updatedAt: now,
  })
  return id
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
    maxTokens: 300,
  })

  const lines = result.text.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l && l !== 'NONE' && l.length > 5 && l.length < 300)

  for (const fact of lines) {
    await saveMemory(spaceId, fact, 'extraction', sessionId)
  }
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
  const memories = await getSpaceMemories(spaceId)
  if (memories.length < 2) return false

  const totalTokens = memories.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)
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
    maxTokens: targetTokens,
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
    await tx.delete(spaceMemories).where(eq(spaceMemories.spaceId, spaceId))
    for (const { id, content } of newMemories) {
      await tx.insert(spaceMemories).values({
        id, spaceId, content, source: 'compact',
        sessionId: null, createdAt: now, updatedAt: now,
      })
    }
  })
  console.log(`  [compact] ${memories.length} → ${newFacts.length} memories in ${Math.round(performance.now() - t0)}ms for space ${spaceId.slice(0, 8)}`)
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
      model: getThinkingModelOrFallback(),
      system: `Extract long-term valuable facts from this conversation. Focus on:
- Preferences and dislikes explicitly stated or strongly implied
- Decisions made (what was chosen and why)
- Constraints the user operates under (time, tools, team, budget)
- Recurring topics that indicate ongoing interest
Output one fact per line prefixed with "- ". Skip ephemeral details. If nothing worth keeping: output "NONE".`,
      prompt: conversation,
    })
    const facts = result.text.split('\n')
      .map(l => l.replace(/^-\s*/, '').trim())
      .filter(l => l && l !== 'NONE' && l.length > 5 && l.length < 300)
    allExtracted.push(...facts)
  }

  // Include manual memories as seeds (they survive regardless)
  const manualMemories = existing.filter(m => m.source === 'manual')
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
Target: approximately ${targetChars} characters total.`,
    prompt: inputLines,
  })

  const newFacts = synthesis.text.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 5 && l.length < 500)

  if (!newFacts.length) {
    console.log(`  [deep-dream] synthesis returned no facts for space ${spaceId.slice(0, 8)}`)
    return false
  }

  // Replace non-manual memories; manual ones survive untouched
  const now = new Date()
  await db.transaction(async tx => {
    await tx.delete(spaceMemories).where(
      and(eq(spaceMemories.spaceId, spaceId), ne(spaceMemories.source, 'manual')),
    )
    for (const content of newFacts) {
      await tx.insert(spaceMemories).values({
        id: randomUUID(), spaceId, content, source: 'compact',
        sessionId: null, createdAt: now, updatedAt: now,
      })
    }
  })

  console.log(`  [deep-dream] ${existing.length} → ${newFacts.length} memories in ${Math.round(performance.now() - t0)}ms for space ${spaceId.slice(0, 8)}`)

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
