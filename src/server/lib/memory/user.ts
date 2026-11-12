/** User-level memory: kept across spaces, saved explicitly or suggested from recent chats. */

import { generateText } from 'ai'
import { randomUUID } from 'crypto'
import { db, userMemories, chatSessions, messages, spaces, monitorRuns, getNumberSetting } from '../db.ts'
import { eq, desc, and, or, isNull } from 'drizzle-orm'
import { getSmallModel, estimateTokens } from '../llm.ts'
import { embedText } from '../embeddings.ts'
import { embedMemory, deleteMemoryEmbeddings } from './store.ts'
import { rankMemoriesByRelevance, selectMemories } from './recall.ts'
import type { UserSettings } from '../../../shared/user-settings.ts'

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
      ranked = (await rankMemoriesByRelevance(rest, query, await embedText(query, 'query'))) ?? rest
    } catch (e) {
      console.error('  [memory] user memory ranking failed:', e)
    }
  }

  const { chosen } = selectMemories(guaranteed, ranked, tokenBudget - estimateTokens(header))
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

/** At most this many candidates from any one chat, so a single long conversation cannot fill the
 *  list with variations on its own subject. */
const SUGGEST_PER_SESSION = 2

/** Episodic phrasing: describes something that happened in a chat, not a standing trait.
 *  "The user asked about the XR-9000" is a log entry; it is true forever and useful never. */
const EPISODIC_PATTERNS: RegExp[] = [
  /\b(asked|enquired|inquired|queried|wanted to know|was wondering|requested)\b/i,
  /\b(mentioned|stated|said|noted|reported|confirmed) that\b/i,
  /\b(discussed|explored|reviewed|analy[sz]ed|researched|investigated)\b/i,
  /\b(in|during|from) (this|the|that|their|a) (chat|conversation|session|thread)\b/i,
]

/** Content words of a fact, for near-duplicate comparison. Stop words are dropped so that two
 *  sentences do not look alike merely for sharing "the user is a". */
const STOP_WORDS = new Set(['the', 'user', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'with', 'their', 'they', 'them', 'it', 'that', 'this', 'has', 'have', 'prefers', 'uses'])

function tokenSet(fact: string): Set<string> {
  return new Set(
    fact.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w)),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

/** Whether a proposed line is actually a durable fact *about the person*.
 *
 *  The extraction prompt asks for exactly this, but small models drift back to summarising the
 *  topic — "the XR-9000 has 16 cores", "the CEO of Acme Corp stepped down" — which is true, useless
 *  as a preference, and would be injected into every future prompt. Requiring the sentence to be
 *  about the user is a cheap structural check that the model's own compliance is not. */
export function isDurableUserFact(fact: string): boolean {
  if (!/^(the\s+)?user\b/i.test(fact.trim())) return false
  return !EPISODIC_PATTERNS.some(re => re.test(fact))
}

/** Deliberately narrower than space extraction (memory/write.ts), which also keeps topical research
 *  findings: those belong to a space, and only durable traits about the person belong here.
 *  Output: at most SUGGEST_PER_SESSION traits, one per line prefixed with "- ", or "NONE". */
const PROFILE_SYSTEM = `You are building a profile of a person from one conversation they had with an assistant.

Report ONLY lasting characteristics of the person: how they want answers written, languages they work in, their role, expertise or employer, tools and platforms they have committed to, and constraints they always apply.

Never report what the conversation was about. A fact about the topic is not a fact about the person, however interesting it is. Examples of what NOT to output, even if the conversation is full of them:
- "The XR-9000 processor has 16 cores"          (a fact about a product)
- "The CEO of Acme Corp stepped down in March"  (a fact about the world)
- "The user asked about the new AI regulation"  (something that happened once, not a trait)
- "The user is interested in processors"        (inferred from a single conversation; too weak)

Good output looks like:
- "The user writes in Swedish and English"
- "The user self-hosts their infrastructure and avoids cloud services"
- "The user is a software engineer working on developer tooling"

Most conversations contain nothing that qualifies. Answering "NONE" is the expected result, and is strongly preferred over a weak guess. Output at most ${SUGGEST_PER_SESSION} lines, each a full sentence starting with "The user", prefixed with "- ".`

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
  // Locked chats are excluded too, by their own lock or their space's: user memory is read by every
  // chat, so a fact drawn from one would carry what it read out of the lock.
  const sessions = await db.select({ id: chatSessions.id })
    .from(chatSessions)
    .leftJoin(monitorRuns, eq(chatSessions.id, monitorRuns.sessionId))
    .leftJoin(spaces, eq(chatSessions.spaceId, spaces.id))
    .where(and(
      eq(chatSessions.userId, userId),
      or(isNull(monitorRuns.id), eq(chatSessions.graduated, 1)),
      eq(chatSessions.locked, false),
      or(isNull(spaces.id), eq(spaces.offline, false)),
    ))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(limit)

  const maxResults = suggestResultCap(sessions.length)
  const existing = (await getUserMemories(userId)).map(m => m.content)
  // Kept per session rather than in one flat list: the final selection interleaves them, so a
  // single chatty conversation cannot crowd out twenty quieter ones.
  const perSession: string[][] = []
  let rejectedTopical = 0

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
        system: PROFILE_SYSTEM,
        prompt: conversation.slice(0, SUGGEST_CONVERSATION_CHARS),
        maxOutputTokens: 200,
      })
      const lines = result.text.split('\n')
        .map(l => l.replace(/^[-*]\s*/, '').trim())
        .filter(l => l && l !== 'NONE' && l.length > 10 && l.length < 300)
      const kept = lines.filter(l => {
        if (isDurableUserFact(l)) return true
        rejectedTopical++
        return false
      })
      if (kept.length) perSession.push(kept.slice(0, SUGGEST_PER_SESSION))
    } catch (e) {
      console.error(`  [memory] suggestion scan failed for session ${sessions[i].id.slice(0, 8)}:`, e)
    }
  }

  // Round-robin across sessions: one from each before a second from any.
  const found: string[] = []
  for (let round = 0; round < SUGGEST_PER_SESSION; round++) {
    for (const facts of perSession) if (facts[round]) found.push(facts[round])
  }

  // Drop anything already known, and near-identical repeats across sessions.
  const chosenTokens: Array<Set<string>> = []
  const suggestions: string[] = []
  let redacted = 0
  let nearDuplicate = 0
  for (const fact of found) {
    // Belt and braces with the prompt rule above: the model is asked not to surface identifiers,
    // and anything that slips through is dropped here rather than offered for one careless click.
    if (isSensitiveFact(fact)) { redacted++; continue }
    const key = fact.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    if (existing.some(e => e.toLowerCase().includes(key) || key.includes(e.toLowerCase()))) continue

    // Exact-match dedup is not enough: several chats on one subject yield rephrasings of the same
    // trait, which read as a list of near-copies. Compare by word overlap instead.
    const tokens = tokenSet(fact)
    if (chosenTokens.some(prev => jaccard(prev, tokens) >= 0.6)) { nearDuplicate++; continue }
    chosenTokens.push(tokens)

    suggestions.push(fact)
    if (suggestions.length >= maxResults) break
  }
  const dropped = [
    rejectedTopical && `${rejectedTopical} about the topic`,
    nearDuplicate && `${nearDuplicate} near-duplicates`,
    redacted && `${redacted} identifying`,
  ].filter(Boolean).join(', ')
  console.log(`  [memory] suggested ${suggestions.length} user memories from ${sessions.length} sessions${dropped ? ` (dropped ${dropped})` : ''}`)
  return suggestions
}

/** The user block, or '' when the user has not opted in. Centralises the gate so no call site can
 *  accidentally inject it for someone who left the setting off. */
export async function userMemoryBlockIfEnabled(
  userId: string,
  settings: UserSettings,
  query?: string,
): Promise<string> {
  if (settings.userMemory !== true) return ''
  const budget = await getNumberSetting('user_memory_token_budget', 300)
  return buildUserMemoryBlock(userId, budget, query)
}
