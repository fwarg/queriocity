import { generateText } from 'ai'
import { getSmallModel } from './llm.ts'
import { queryTerms, querySimilarity, hasMangledToken, QUERY_DUPLICATE_THRESHOLD } from './query-terms.ts'

const PRONOUN_RE = /\b(it|its|they|their|them|this|that|these|those|he|him|his|she|her|hers|we|us|our|ours)\b/i

/** Speed mode: regex heuristic, no LLM call. Returns single query string. */
export function reformulateSpeed(messages: Array<{ role: string; content: string }>): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return ''

  if (messages.length <= 1 || !PRONOUN_RE.test(lastUser.content)) {
    console.log(`  [speed] passthrough → ${JSON.stringify(lastUser.content)}`)
    return lastUser.content
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  if (!lastAssistant) {
    console.log(`  [speed] passthrough (no assistant turn) → ${JSON.stringify(lastUser.content)}`)
    return lastUser.content
  }

  const subject = lastAssistant.content.match(/^[^,.]+/)?.[0]?.trim()
  if (!subject) {
    console.log(`  [speed] passthrough (no subject) → ${JSON.stringify(lastUser.content)}`)
    return lastUser.content
  }

  const q = `${subject}: ${lastUser.content}`
  console.log(`  [speed] subject-prepend → ${JSON.stringify(q)}`)
  return q
}

// Reformulation sits on the critical path of every balanced/thorough query, before a single byte
// reaches the client, so it must never be the thing that hangs a request. The caller degrades to
// no pre-search on failure, which is far better than an unbounded wait.
const REFORMULATE_TIMEOUT_MS = parseInt(process.env.REFORMULATE_TIMEOUT_MS ?? '8000', 10)

// Built per call, not at module load. A server that has been up since December otherwise keeps
// telling the model today's date is in December and to append last year to every "latest" query —
// which is exactly the class of question reformulation exists to sharpen. researcher.ts already
// takes `new Date()` per call for the same reason.
export function reformulateSystem(now = new Date()): string {
  const TODAY = now.toISOString().split('T')[0]
  const YEAR = now.getFullYear()
  return `You are a search query optimizer. Rewrite the user question as an optimized search query. Today's date is ${TODAY}.

Rules:
1. Strip conversational filler. Output short keywords, not sentences — a search engine, not a human, reads this.
2. KEEP any wording that pins down WHICH thing the user means: an apposition ("DOGE, the department run by Elon Musk"), a field, a company, a location, a time period. This overrides rule 1 — dropping it sends the search to a different subject entirely, which is worse than a slightly longer query. Never resolve an ambiguous name to one sense on your own; carry the user's qualifier through.
3. Never split or respell a name the user wrote. Copy it exactly as it appears.
4. For products, technologies, companies, software, or other topics primarily covered in English sources, write the query in English regardless of the user's language.
5. Append the year ${YEAR} ONLY when the answer depends on what is newest or current right now: latest versions/releases, prices, rankings, schedules, ongoing events, news, or questions that say "latest/current/newest/now". Do NOT add a year to definitions, explanations, how-to, or conceptual questions ("what is X", "how does Y work") — even for cutting-edge or AI topics. When unsure, do not add a year.
6. Output ONLY the search string. No explanations, no quotes, no preamble.

Examples:
- "vad är hidden state engineering" → hidden state engineering        (concept — no year)
- "how does RAG work" → retrieval augmented generation how it works   (concept — no year)
- "senaste iPhone" → latest iPhone ${YEAR}                            (newest — add year)
- "best LLM for coding right now" → best LLM coding ${YEAR}           (current ranking — add year)
- "What happened to DOGE, the department run by Elon Musk?"
  → DOGE Department of Government Efficiency status ${YEAR}           (keep the qualifier — "DOGE" alone finds the cryptocurrency)
- "Hur gick det för Vasaloppet i år?" → Vasaloppet results ${YEAR}    (English for an international topic, name kept verbatim)`
}

/** Returns true if the string looks like a natural language sentence rather than a search query. */
function looksLikeSentence(s: string): boolean {
  return /\b(stands? for|is an? |refers to|means |is the abbreviation|is short for|is used to|was (founded|created|established))\b/i.test(s)
    || s.endsWith('.')
}

// A raw user question longer than this makes a poor search query — which is the whole reason
// reformulation exists — so the raw-query safety net below only applies to short ones.
const RAW_QUERY_MAX_WORDS = 12

/** Balanced/thorough mode: small LLM rewrites query as optimized search queries.
 *  Owns the query cap for the mode; callers should not slice the result further. */
export async function reformulateLLM(
  messages: Array<{ role: string; content: string }>,
  mode: 'balanced' | 'thorough',
  abortSignal?: AbortSignal,
): Promise<string[]> {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return []

  const count = mode === 'thorough' ? 3 : 2

  // Only pass the immediately preceding turn — enough to resolve pronouns and
  // judge what's already in context, without overflowing the small model's window.
  const prevMessages = messages.slice(0, -1).filter(m => m.role === 'user' || m.role === 'assistant')
  const lastAssistant = [...prevMessages].reverse().find(m => m.role === 'assistant')
  const lastPriorUser = [...prevMessages].reverse().find(m => m.role === 'user')
  const userCtxLen = parseInt(process.env.REFORMULATE_USER_CTX ?? '300', 10)
  const assistantCtxLen = parseInt(process.env.REFORMULATE_ASSISTANT_CTX ?? '800', 10)
  const historyParts = [
    lastPriorUser ? `user: ${lastPriorUser.content.slice(0, userCtxLen)}` : '',
    lastAssistant ? `assistant: ${lastAssistant.content.slice(0, assistantCtxLen)}` : '',
  ].filter(Boolean)

  const contextPart = historyParts.length
    ? `Previous turn:\n${historyParts.join('\n')}\n\nLatest question: ${lastUser.content}`
    : lastUser.content

  const userPrompt = `Rewrite into ${count} complementary search queries covering different angles, one per line: "${contextPart}"`

  const SMALL_TARGET = `${process.env.SMALL_BASE_URL ?? process.env.CHAT_BASE_URL ?? process.env.BASE_URL ?? 'openai'} model=${process.env.SMALL_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2'}`
  console.log(`  [reformulate] ${SMALL_TARGET} mode=${mode} count=${count}`)
  const start = performance.now()

  const timeout = AbortSignal.timeout(REFORMULATE_TIMEOUT_MS)
  const { text } = await generateText({
    model: getSmallModel(),
    system: reformulateSystem(),
    prompt: userPrompt,
    maxOutputTokens: 120,
    abortSignal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout,
  })

  console.log(`  [reformulate] done — ${(performance.now() - start).toFixed(0)}ms → ${JSON.stringify(text.trim())}`)

  const lines = text
    .split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(l => l && !/^skip$/i.test(l) && !looksLikeSentence(l))

  // Dedup (normalized): the small model sometimes repeats a line, wasting a search.
  const seen = new Set<string>()
  const deduped = lines
    .filter(l => { const k = l.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
    .slice(0, count)

  // Drop a query that splits a name the user wrote ("DOGE" → "do ge"), which searches as two
  // meaningless tokens. Compared against the whole context, not just the latest message: on a
  // follow-up the mangled name usually comes from the previous turn.
  const usable = deduped.filter(q => {
    if (!hasMangledToken(q, contextPart)) return true
    console.warn(`  [reformulate] discarded mangled query ${JSON.stringify(q)}`)
    return false
  })

  // Safety net for the failure this cannot detect any other way: the model silently resolving an
  // ambiguous name to the wrong sense ("DOGE, the department run by Elon Musk" → "DOGE stock
  // price"). Searching the user's own short question alongside the rewrites costs one parallel
  // query and reliably surfaces the intended subject. Skipped when a rewrite already covers it.
  const raw = lastUser.content.trim()
  const rawTerms = queryTerms(raw)
  const rawIsUsable = raw.split(/\s+/).length <= RAW_QUERY_MAX_WORDS && rawTerms.size > 0
  const alreadyCovered = usable.some(q => querySimilarity(queryTerms(q), rawTerms) >= QUERY_DUPLICATE_THRESHOLD)
  if (rawIsUsable && !alreadyCovered) {
    console.log(`  [reformulate] adding raw query as safety net: ${JSON.stringify(raw)}`)
    usable.push(raw)
  }

  return usable
}
