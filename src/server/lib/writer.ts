import { streamText } from 'ai'
import { getChatModel } from './llm.ts'
import type { SearchResult } from './searxng.ts'

const WRITER_SYSTEM = `You are a research writer. Given the research results, write a well-structured report.

Formatting rules:
- Use ## for main section headings, ### for subsections if needed.
- Use bullet points or numbered lists for steps, requirements, or any enumerable content — avoid turning these into prose.
- Keep paragraphs short: 2–4 sentences maximum. Prefer lists over long paragraphs.
- Cite every factual claim inline with [N] notation. Every paragraph or list item needs at least one citation.
- Do not invent information not found in the sources.

Structure:
1. One short introductory paragraph (3–5 sentences, no heading).
2. Several ## sections covering distinct aspects of the topic (background, process, current status, obstacles, outlook, etc. — adapt to the question).
3. A brief ## Conclusion or ## Summary section.`

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
