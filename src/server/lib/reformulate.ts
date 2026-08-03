import { generateText } from 'ai'
import { getSmallModel } from './llm.ts'

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

const NOW = new Date()
const TODAY = NOW.toISOString().split('T')[0]
const YEAR = NOW.getFullYear()

const REFORMULATE_SYSTEM = `You are a search query optimizer. Rewrite the user question as an optimized search query. Today's date is ${TODAY}.

Rules:
1. Strip conversational filler. Output short keywords, not sentences — a search engine, not a human, reads this.
2. For products, technologies, companies, software, or other topics primarily covered in English sources, write the query in English regardless of the user's language.
3. Append the year ${YEAR} ONLY when the answer depends on what is newest or current right now: latest versions/releases, prices, rankings, schedules, ongoing events, news, or questions that say "latest/current/newest/now". Do NOT add a year to definitions, explanations, how-to, or conceptual questions ("what is X", "how does Y work") — even for cutting-edge or AI topics. When unsure, do not add a year.
4. Output ONLY the search string. No explanations, no quotes, no preamble.

Examples:
- "vad är hidden state engineering" → hidden state engineering        (concept — no year)
- "how does RAG work" → retrieval augmented generation how it works   (concept — no year)
- "senaste iPhone" → latest iPhone ${YEAR}                            (newest — add year)
- "best LLM for coding right now" → best LLM coding ${YEAR}           (current ranking — add year)`

/** Returns true if the string looks like a natural language sentence rather than a search query. */
function looksLikeSentence(s: string): boolean {
  return /\b(stands? for|is an? |refers to|means |is the abbreviation|is short for|is used to|was (founded|created|established))\b/i.test(s)
    || s.endsWith('.')
}

/** Balanced/thorough mode: small LLM rewrites query as optimized search queries. */
export async function reformulateLLM(
  messages: Array<{ role: string; content: string }>,
  mode: 'balanced' | 'thorough',
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

  const { text } = await generateText({
    model: getSmallModel(),
    system: REFORMULATE_SYSTEM,
    prompt: userPrompt,
    maxOutputTokens: 120,
  })

  console.log(`  [reformulate] done — ${(performance.now() - start).toFixed(0)}ms → ${JSON.stringify(text.trim())}`)

  const lines = text
    .split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(l => l && !/^skip$/i.test(l) && !looksLikeSentence(l))

  // Dedup (normalized): the small model sometimes repeats a line, wasting a search.
  const seen = new Set<string>()
  return lines
    .filter(l => { const k = l.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
    .slice(0, count)
}
