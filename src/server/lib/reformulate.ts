import { generateText } from 'ai'
import { getSmallModel } from './llm.ts'

const PRONOUN_RE = /\b(it|its|they|their|this|that|these|those)\b/i

/** Speed mode: regex heuristic, no LLM call. Returns single query string. */
export function reformulateSpeed(messages: Array<{ role: string; content: string }>): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return ''

  if (messages.length <= 1 || !PRONOUN_RE.test(lastUser.content)) {
    return lastUser.content
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  if (!lastAssistant) return lastUser.content

  const subject = lastAssistant.content.match(/^[^,.]+/)?.[0]?.trim()
  if (!subject) return lastUser.content

  return `${subject}: ${lastUser.content}`
}

const REFORMULATE_SYSTEM = `You are a search query optimizer. Your task is to rewrite the user's input into a concise, effective search engine query.

Rules:
1. Strip away conversational filler (e.g., "can you find", "please search for").
2. Identify the core intent and use keywords that a search engine favors.
3. If the input is in Swedish, output the search query in Swedish. If in English, output in English.
4. Output ONLY the search string. No explanations, no quotes, no preamble.

Example 1 (Input): "Jag undrar hur man bakar surdegsbröd hemma utan en gjutjärnsgryta"
Example 1 (Output): recept surdegsbröd utan gjutjärnsgryta guide

Example 2 (Input): "What is the best way to clean a mechanical keyboard without breaking it?"
Example 2 (Output): how to clean mechanical keyboard safely`

/** Balanced/thorough mode: small LLM rewrites query as optimized search queries. */
export async function reformulateLLM(
  messages: Array<{ role: string; content: string }>,
  mode: 'balanced' | 'thorough',
): Promise<string[]> {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return []

  const count = mode === 'thorough' ? 3 : 1
  const history = messages
    .slice(0, -1)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role}: ${m.content}`)
    .join('\n')

  const contextPart = history
    ? `Conversation so far:\n${history}\n\nLatest question: ${lastUser.content}`
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
    prompt: userPrompt,
  })

  console.log(`  [reformulate] done — ${(performance.now() - start).toFixed(0)}ms → ${JSON.stringify(text.trim())}`)

  return text
    .split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, count)
}
