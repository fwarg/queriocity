import { generateText } from 'ai'
import { getSmallModel } from './llm.ts'

const PRONOUN_RE = /\b(it|its|they|their|this|that|these|those)\b/i

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

const REFORMULATE_SYSTEM = `You are a search query optimizer. Decide whether a web search is needed, then rewrite the query if so.

Rules:
1. Output the word SKIP if the question can be answered from conversation context or is purely definitional/conceptual with no time-sensitive component (e.g. "what does X stand for", "explain Y", "what did you mean by Z").
2. Output a search query if the question involves current events, recent news, statistics, prices, or anything that may have changed.
3. Strip conversational filler. Use keywords a search engine favors.
4. Match the language of the input (Swedish → Swedish, English → English).
5. Output ONLY the search string or SKIP. No explanations, no quotes, no preamble.

Example 1 (Input): "What does CETA stand for?" → SKIP
Example 2 (Input): "What is the latest news on EU-Canada trade?" → EU Canada trade news 2025
Example 3 (Input): "What is the best way to clean a mechanical keyboard?" → how to clean mechanical keyboard safely`

/** Balanced/thorough mode: small LLM rewrites query as optimized search queries. */
export async function reformulateLLM(
  messages: Array<{ role: string; content: string }>,
  mode: 'balanced' | 'thorough',
): Promise<string[]> {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return []

  const count = mode === 'thorough' ? 3 : 1

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

  const userPrompt = count === 1
    ? `Rewrite into 1 optimized query: "${contextPart}"`
    : `Rewrite into ${count} complementary queries covering different angles, one per line: "${contextPart}"`

  const SMALL_TARGET = `${process.env.SMALL_BASE_URL ?? process.env.CHAT_BASE_URL ?? 'ollama'} model=${process.env.SMALL_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2'}`
  console.log(`  [reformulate] ${SMALL_TARGET} mode=${mode} count=${count}`)
  const start = performance.now()

  const { text } = await generateText({
    model: getSmallModel(),
    system: REFORMULATE_SYSTEM,
    prompt: process.env.NO_THINK_TRIGGER ? `${process.env.NO_THINK_TRIGGER}\n${userPrompt}` : userPrompt,
    maxTokens: 80,
  })

  console.log(`  [reformulate] done — ${(performance.now() - start).toFixed(0)}ms → ${JSON.stringify(text.trim())}`)

  return text
    .split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(l => l && !/^skip$/i.test(l))
    .slice(0, count)
}
