import { generateText } from 'ai'
import { randomUUID } from 'crypto'
import { db, spaceMemories } from './db.ts'
import { eq, desc } from 'drizzle-orm'
import { getSmallModel } from './llm.ts'

export interface SpaceMemory {
  id: string
  spaceId: string
  content: string
  source: 'tool' | 'extraction' | 'manual'
  sessionId: string | null
  createdAt: Date
  updatedAt: Date
}

/** Load all memories for a space, newest first. */
export async function getSpaceMemories(spaceId: string) {
  return db.select().from(spaceMemories)
    .where(eq(spaceMemories.spaceId, spaceId))
    .orderBy(desc(spaceMemories.createdAt))
}

/** Build a formatted memory block for system prompt injection. */
export async function buildMemoryBlock(spaceId: string, tokenBudget = 1000): Promise<string> {
  const memories = await getSpaceMemories(spaceId)
  if (!memories.length) return ''

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

  if (!lines.length) return ''
  const block = header + '\n' + lines.join('\n')
  console.log(`  [memory] injecting ${lines.length} memories (~${Math.ceil(block.length / 4)} tokens) for space ${spaceId.slice(0, 8)}`)
  return block
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

  const result = await generateText({
    model: getSmallModel(),
    system: `Extract noteworthy facts, preferences, or decisions from this conversation that would be useful to remember for future conversations. Output one fact per line, prefixed with "- ". Only extract genuinely useful long-term facts, not ephemeral details. If there are no noteworthy facts, output "NONE".`,
    prompt: `User: ${userContent}\n\nAssistant: ${assistantContent.slice(0, 2000)}`,
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
