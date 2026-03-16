import { streamText } from 'ai'
import { getChatModel } from './llm.ts'
import type { SearchResult } from './searxng.ts'

const WRITER_SYSTEM = `You are a precise writer. Given the research results below, write a comprehensive answer.
- Cite every factual claim with [number] notation referencing the source list.
- Every paragraph must contain at least one citation.
- Structure: brief intro, main content, conclusion.`

export function runWriter(
  sources: SearchResult[],
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
  const sourcesBlock = sources
    .map((s, i) => `<result index=${i + 1} title="${s.title}" url="${s.url}">${s.content}</result>`)
    .join('\n')

  const lastUser = [...messages].reverse().find(m => m.role === 'user')

  return streamText({
    model: getChatModel(),
    system: WRITER_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Research results:\n${sourcesBlock}\n\nQuestion: ${lastUser?.content ?? ''}`,
      },
    ],
  })
}
