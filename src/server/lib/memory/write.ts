/** Saving space memories, with write-time conflict resolution against what is already stored. */

import { generateText } from 'ai'
import { randomUUID } from 'crypto'
import { db, spaceMemories, sqlite, getNumberSetting } from '../db.ts'
import { eq } from 'drizzle-orm'
import { getSmallModel, SMALL_MODEL_INPUT_CHARS } from '../llm.ts'
import { embedTexts } from '../embeddings.ts'
import { type MemorySource, type RankableSource, type MemoryFact, MEMORY_MAX_SOURCES, slimSource, dedupeByUrl, unionSources, pickFallbackSources, mapFactCitations } from './sources.ts'
import { getSpaceMemories, embedMemory, backfillMemoryEmbeddings, nearestMemoryIds } from './store.ts'

type MemoryRow = Awaited<ReturnType<typeof getSpaceMemories>>[number]

interface MemoryWrite {
  /** UPDATE rewrites `targetId` in place; DELETE removes it and adds the new fact separately. */
  op: 'ADD' | 'UPDATE' | 'NOOP'
  fact: string
  targetId?: string
  /** For ADD: the new fact's sources. For UPDATE: union of the new fact's and the target's. */
  sources?: MemorySource[]
}

/** The existing memories a new fact might duplicate or contradict — its nearest neighbours. */
async function conflictCandidates(existing: MemoryRow[], facts: string[]): Promise<MemoryRow[]> {
  if (!existing.length) return []
  await backfillMemoryEmbeddings(existing)
  const byId = new Map(existing.map(m => [m.id, m]))
  const scope = existing.map(m => m.id)
  const picked = new Set<string>()
  try {
    const embeddings = await embedTexts(facts, 'query')
    for (const embedding of embeddings) {
      for (const id of nearestMemoryIds(embedding, scope, 5)) picked.add(id)
    }
  } catch (e) {
    console.error('  [memory] conflict candidate lookup failed:', e)
    return []
  }
  return [...picked].map(id => byId.get(id)!).filter(Boolean)
}

/** Output: a JSON array, one `{ i, op, target? }` per new fact in order; `op` is ADD, UPDATE or NOOP. */
const PLAN_WRITES_SYSTEM = `You maintain a user's long-term memory. For each NEW fact decide exactly one action:
- ADD: genuinely new information.
- UPDATE: it supersedes an EXISTING memory (same subject, changed or more specific value). Give the existing index.
- NOOP: already covered by an existing memory; adds nothing.
Prefer ADD when unsure. Never merge unrelated subjects.
Respond with ONLY a JSON array, one object per new fact, in order:
[{"i":0,"op":"ADD"},{"i":1,"op":"UPDATE","target":3},{"i":2,"op":"NOOP"}]`

/** Ask the small model whether each fact is new, an update of an existing memory, or redundant.
 *  On any failure every fact falls back to ADD — a duplicate is recoverable, a lost fact is not. */
async function planMemoryWrites(facts: MemoryFact[], candidates: MemoryRow[]): Promise<MemoryWrite[]> {
  const fallback: MemoryWrite[] = facts.map(f => ({ op: 'ADD', fact: f.text, sources: f.sources }))
  if (!candidates.length) return fallback

  const existingList = candidates.map((m, i) => `[${i}] ${m.content}`).join('\n')
  const newList = facts.map((f, i) => `(${i}) ${f.text}`).join('\n')
  try {
    const result = await generateText({
      model: getSmallModel(),
      system: PLAN_WRITES_SYSTEM,
      prompt: `EXISTING MEMORIES:\n${existingList}\n\nNEW FACTS:\n${newList}`,
      maxOutputTokens: 400,
    })
    const json = result.text.replace(/```(?:json)?/g, '').trim()
    const start = json.indexOf('[')
    const parsed = JSON.parse(json.slice(start, json.lastIndexOf(']') + 1)) as
      Array<{ i: number; op: string; target?: number }>

    const writes = [...fallback]
    // One existing memory can be replaced at most once. Two facts both claiming UPDATE on the same
    // target ran two sequential updates against the same row, so the first was overwritten by the
    // second and never inserted anywhere — a lost fact, which this module treats as the one
    // outcome worse than a duplicate. The later claim falls back to ADD.
    const claimed = new Set<string>()
    for (const d of parsed) {
      if (typeof d.i !== 'number' || !writes[d.i]) continue
      const target = typeof d.target === 'number' ? candidates[d.target] : undefined
      // The user's own words are never overwritten or discarded by the model; downgrade to ADD
      // so the new fact is still kept and the two can be reconciled by a human or the dream.
      const locked = target && (target.source === 'manual' || target.alwaysKeep)
      if (d.op === 'UPDATE' && target && !locked && !claimed.has(target.id)) {
        claimed.add(target.id)
        writes[d.i] = {
          op: 'UPDATE',
          fact: writes[d.i].fact,
          targetId: target.id,
          sources: unionSources(facts[d.i].sources, target.sources),
        }
      } else if (d.op === 'NOOP' && !locked) {
        writes[d.i] = { op: 'NOOP', fact: writes[d.i].fact }
      }
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
  facts: Array<string | MemoryFact>,
  source: 'tool' | 'extraction' | 'manual',
  sessionId?: string,
): Promise<void> {
  // Sources ride inside the fact object through both filters below — a parallel array would
  // desync at the trim and the novelty filter and mis-attribute a source to the wrong fact.
  const trimmed: MemoryFact[] = facts
    .map(f => (typeof f === 'string' ? { text: f.trim() } : { ...f, text: f.text.trim() }))
    .filter(f => f.text)
  if (!trimmed.length) return

  const existing = await db.select().from(spaceMemories).where(eq(spaceMemories.spaceId, spaceId))
  // Exact containment is settled without troubling the model.
  const novel = trimmed.filter(f => !existing.some(m => m.content.includes(f.text)))
  if (!novel.length) return

  const candidates = await conflictCandidates(existing, novel.map(f => f.text))
  const writes = await planMemoryWrites(novel, candidates)

  let added = 0, updated = 0, skipped = 0
  for (const w of writes) {
    if (w.op === 'NOOP') { skipped++; continue }
    if (w.op === 'UPDATE' && w.targetId) {
      // Content changed, so the sources are no longer known to have been re-verified.
      await db.update(spaceMemories)
        .set({ content: w.fact, sources: w.sources ?? null, checkedAt: null, updatedAt: new Date() })
        .where(eq(spaceMemories.id, w.targetId))
      await embedMemory(w.targetId, w.fact)
      updated++
      continue
    }
    await saveMemory(spaceId, w.fact, source, sessionId, w.sources)
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
  sources?: MemorySource[],
): Promise<string> {
  const trimmed = content.trim()
  if (!trimmed) return ''
  // Storage backstop: whatever the caller passes, a memory never keeps more than the cap.
  const capped = sources?.length ? dedupeByUrl(sources).map(slimSource).slice(0, MEMORY_MAX_SOURCES) : undefined

  const existing = await db.select().from(spaceMemories)
    .where(eq(spaceMemories.spaceId, spaceId))

  for (const m of existing) {
    if (m.content.includes(trimmed)) return m.id // existing is more detailed
    if (trimmed.includes(m.content)) {
      // new content is more detailed — replace, carrying both sides' provenance forward
      const now = new Date()
      await db.update(spaceMemories)
        .set({ content: trimmed, sources: unionSources(capped, m.sources) ?? null, checkedAt: null, updatedAt: now })
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
    // The cited pages were fetched live moments ago, so "last seen good" is now. Memories with no
    // web sources (manual, tool calls that read nothing) stay unverified.
    sources: capped ?? null,
    checkedAt: capped ? Math.floor(Date.now() / 1000) : null,
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

/** Output: one note per line prefixed with "- ", or "NONE"; `[N]` markers are kept for mapFactCitations. */
const EXTRACT_SYSTEM = `Extract noteworthy facts, preferences, decisions, or research findings from this conversation that would be useful in future conversations in this space. Write each as a single self-contained note of 1-3 sentences — include enough context that it stands on its own later. Preserve any [N] citation markers from the assistant's message that support the note. Output one note per line, prefixed with "- ". Only durable, useful information — skip ephemeral details. If there is nothing worth keeping, output "NONE".`

/** Extract memories from a completed chat using the small model. */
export async function extractMemoriesPostHoc(
  spaceId: string,
  sessionId: string,
  userContent: string,
  assistantContent: string,
  turnSources: RankableSource[] = [],
): Promise<void> {
  if (!userContent.trim()) return
  const t0 = performance.now()

  // Clamped to what the configured small model can actually accept. The admin setting allows up to
  // 100000 chars, which no 4k-context model can take — and the extraction then fails outright
  // rather than extracting less. A non-numeric setting falls back to 6000 (getNumberSetting): as NaN,
  // `slice(-NaN)` would silently return the *whole* string, disabling the limit rather than tripping it.
  const configured = await getNumberSetting('memory_extract_chars', 6000)
  const maxChars = Math.min(configured, SMALL_MODEL_INPUT_CHARS)
  const combined = `User: ${userContent}\n\nAssistant: ${assistantContent}`
  const result = await generateText({
    model: getSmallModel(),
    system: EXTRACT_SYSTEM,
    prompt: combined.slice(-maxChars),
    maxOutputTokens: 600,
  })

  const mapped = result.text.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l && l !== 'NONE')
    .map(l => mapFactCitations(l, turnSources))
    .filter(f => f.text.length > 5 && f.text.length < 400)

  // A note that named its own `[N]` keeps exactly those; one that named none gets the turn's
  // sources ranked against its text and capped, rather than the whole (often dozens-long) list.
  // Serial, not Promise.all: a local reranker is happier with one request at a time.
  const facts: MemoryFact[] = []
  for (const f of mapped) {
    facts.push(f.sources !== undefined ? f : { text: f.text, sources: await pickFallbackSources(f.text, turnSources) })
  }

  // One planning call for the whole batch: routing each fact through saveMemory individually
  // would cost an extra small-model round-trip per fact on every turn.
  await saveMemories(spaceId, facts, 'extraction', sessionId)
  console.log(`  [memory] post-hoc extracted ${facts.length} facts in ${Math.round(performance.now() - t0)}ms (small model)`)
}
