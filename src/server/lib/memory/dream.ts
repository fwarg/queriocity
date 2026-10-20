/** Keeping space memory small: compaction, deep re-extraction from chats, and the nightly run. */

import { generateText } from 'ai'
import { randomUUID } from 'crypto'
import { db, spaceMemories, chatSessions, messages, spaces, getAppSetting, getNumberSetting, setAppSetting } from '../db.ts'
import { eq, asc, ne, and, gt, sql } from 'drizzle-orm'
import { getSmallModel, getChatModel, getThinkingModelOrFallback, localTurnModels, modelTarget, estimateTokens, tokensToChars } from '../llm.ts'
import { contextCharBudget } from '../trim-messages.ts'
import { semanticChunk } from '../chunker.ts'
import { getSpaceMemories, deleteMemoryEmbeddings, backfillMemoryEmbeddings } from './store.ts'

/** Output: the compacted facts, one per line prefixed with "- ". */
const compactSystem = (targetChars: number) => `You are a memory compactor. Given a list of facts from a user's space memory:
1. Merge near-duplicate or redundant facts into one
2. Remove facts that are subsets of others
3. Preserve all unique information
Keep each fact self-contained and specific (1-3 sentences); never truncate concrete details to save space.
Output ONLY the final list, one fact per line, prefixed with "- ". No other text. No preamble.
Target: approximately ${targetChars} characters total.`

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

  const totalTokens = allMemories.reduce((n, m) => n + estimateTokens(m.content), 0)
  if (totalTokens <= triggerTokens) return false

  const t0 = performance.now()
  const input = memories.map(m => `- ${m.content}`).join('\n')

  const result = await generateText({
    model: getSmallModel(),
    system: compactSystem(tokensToChars(targetTokens)),
    prompt: input,
    maxOutputTokens: targetTokens,
  })

  const newFacts = result.text.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 5 && l.length < 700)

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
      // A merged fact has no single origin, so it carries no `sources`/`checkedAt` — the same
      // accepted loss as `sessionId: null` here. Manual and always-keep rows keep their provenance.
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

/** Output: one fact per line prefixed with "- ", or "NONE". */
const DEEP_EXTRACT_SYSTEM = `Extract long-term valuable facts from this conversation. Include both:
- User context: preferences, decisions, constraints, recurring interests
- Research findings: key facts, conclusions, standards, tools, or sources surfaced by the assistant that would be useful to recall in future conversations on this topic
Write each fact as 1-3 self-contained sentences. Output one fact per line prefixed with "- ". Be specific — capture the actual finding, not just the topic. Skip ephemeral details. If nothing worth keeping: output "NONE".`

/** Facts from every chat in the space, oldest chat first.
 *
 *  A chat longer than the chat model's window is read in consecutive pieces: sent whole, it
 *  overflowed the context and the request failed. Serial, like the other extraction paths — a local
 *  model server works through one request at a time anyway. */
async function extractSpaceChatFacts(spaceId: string): Promise<string[]> {
  const rows = await db.select({ sessionId: messages.sessionId, role: messages.role, content: messages.content })
    .from(messages)
    .innerJoin(chatSessions, eq(chatSessions.id, messages.sessionId))
    .where(eq(chatSessions.spaceId, spaceId))
    .orderBy(asc(chatSessions.createdAt), asc(chatSessions.id), sql`messages.rowid`)
  const chats = new Map<string, string[]>()
  for (const m of rows) {
    const turns = chats.get(m.sessionId) ?? []
    turns.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    chats.set(m.sessionId, turns)
  }

  const pieceChars = contextCharBudget(modelTarget('chat').contextTokens)
  const facts: string[] = []
  for (const turns of chats.values()) {
    for (const piece of semanticChunk(turns.join('\n\n'), pieceChars, 0)) {
      const result = await generateText({ model: getChatModel(), system: DEEP_EXTRACT_SYSTEM, prompt: piece })
      facts.push(...result.text.split('\n')
        .map(l => l.replace(/^-\s*/, '').trim())
        .filter(l => l && l !== 'NONE' && l.length > 5 && l.length < 400))
    }
  }
  return facts
}

/** The newest lines (the list is oldest-first) whose joined length fits `maxChars`. */
function newestWithin(lines: string[], maxChars: number): string[] {
  let used = 0
  let start = lines.length
  while (start > 0 && used + lines[start - 1].length + 1 <= maxChars) used += lines[--start].length + 1
  return lines.slice(start)
}

/** Input: extracted facts oldest-first, then the manual and always-keep ones. Output: one fact per line prefixed with "- ". */
const consolidationSystem = (targetChars: number) => `You are consolidating a space memory from multiple conversations.
Facts are listed oldest-first. When facts conflict, prefer the newer one.

Tasks:
1. Merge near-duplicates into the more specific/recent version
2. Remove facts that are fully covered by another
3. If the same topic recurs across many facts, synthesize a general preference
4. Preserve all unique constraints, decisions, and preferences

Each fact may be 1-3 sentences; keep the specifics that make it usable.
Output ONLY the final fact list, one per line, prefixed with "- ".
Be ruthless: if in doubt, cut. Total output MUST NOT exceed ${targetChars} characters.`

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
  const allExtracted = await extractSpaceChatFacts(spaceId)

  // Include manual and always-keep memories as seeds (they survive regardless)
  const manualMemories = existing.filter(m => m.source === 'manual' || m.alwaysKeep)
  const manualLines = manualMemories.map(m => `- ${m.content}`)
  const extractedLines = allExtracted.map(f => `- ${f}`)

  if (!extractedLines.length && !manualLines.length) {
    console.log(`  [deep-dream] nothing to synthesise for space ${spaceId.slice(0, 8)}, skipping`)
    return false
  }

  // Stage 2: synthesis — resolve contradictions, merge, infer patterns. What does not fit the
  // thinking model's window (less room for its output) is dropped oldest-first; seeds always stay.
  const targetChars = tokensToChars(targetTokens)
  const inputBudget = contextCharBudget(localTurnModels().thinking.contextTokens) - targetChars
  const inputLines = [...newestWithin(extractedLines, inputBudget - manualLines.join('\n').length), ...manualLines].join('\n')

  const synthesis = await generateText({
    model: getThinkingModelOrFallback(),
    system: consolidationSystem(targetChars),
    prompt: inputLines,
  })

  const newFacts = synthesis.text.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 5 && l.length < 700)

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
      // Synthesised across many conversations with no fact-to-fact mapping, so no `sources`/
      // `checkedAt` — same accepted loss as `sessionId: null`. Manual/always-keep rows survive.
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
  const newTotal = newFacts.reduce((n, f) => n + estimateTokens(f), 0)
  if (newTotal > targetTokens) {
    await compactSpaceMemories(spaceId, targetTokens)
  }

  return true
}

export async function runDream() {
  const [threshold, target, deep] = await Promise.all([
    getNumberSetting('dream_threshold', 1500),
    getNumberSetting('dream_target', 700),
    getAppSetting('dream_deep', 'false').then(v => v === 'true'),
  ])
  const allSpaces = await db.select({ id: spaces.id }).from(spaces)
  console.log(`  [dream] checking ${allSpaces.length} spaces (threshold=${threshold}, target=${target}, deep=${deep})`)
  for (const sp of allSpaces) {
    // Per space, as suggestUserMemories already does for each session. Compaction feeds whole
    // conversations to the model, so one space large enough to overflow the context used to throw
    // past this loop and silently skip every space after it — for that whole night.
    try {
      if (deep) {
        const key = `deep_dream_at_${sp.id}`
        const lastRunAt = new Date(await getNumberSetting(key, 0))
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
    } catch (e) {
      console.error(`  [dream] space ${sp.id} failed, continuing:`, e)
    }
  }
  console.log(`  [dream] done`)
}
