import { streamText } from 'ai'
import { getChatModel, RESEARCH_MAX_TOKENS } from './llm.ts'
import { contextCharBudget } from './trim-messages.ts'
import type { SearchResult } from './searxng.ts'

const WRITER_SYSTEM = `You are a research writer. Given the research results, write a well-structured report.

Formatting rules:
- Use ## for main section headings, ### for subsections if needed.
- Use bullet points or numbered lists for steps, requirements, or any enumerable content — avoid turning these into prose.
- Keep paragraphs short: 2–4 sentences maximum. Prefer lists over long paragraphs.
- Cite every factual claim inline using only [N] notation (e.g. [1], [2][3]). Do NOT use markdown hyperlinks ([text](url)) — only [N] numbers. Only cite sources that directly support the claim. Omit citations if no source is relevant. Do NOT include a reference list or source list at the end.
- Do not invent information not found in the sources.
- Always respond in the same language the user used.

Structure:
1. One short introductory paragraph (3–5 sentences, no heading).
2. Several ## sections covering distinct aspects of the topic (background, process, current status, obstacles, outlook, etc. — adapt to the question).
3. A brief ## Conclusion or ## Summary section.`

// Floor on what one source contributes once the block is squeezed to fit. Below roughly this,
// a snippet is too clipped to support a citation, so it is better to carry fewer sources in full
// than to carry all of them as unusable fragments.
const MIN_SOURCE_CHARS = 300

/** Fits the sources into `budgetChars`, trimming each source's content to an equal share and
 *  dropping the lowest-ranked sources rather than clipping every one below usefulness.
 *  Sources arrive best-first from the reranker, so dropping from the end sheds the weakest. */
function fitSources(sources: SearchResult[], budgetChars: number): { block: string; used: number } {
  const overhead = (s: SearchResult) => `<result index=0 title="${s.title}" url="${s.url}"></result>\n`.length
  let kept = sources
  while (kept.length > 0) {
    const fixed = kept.reduce((sum, s) => sum + overhead(s), 0)
    const perSource = Math.floor((budgetChars - fixed) / kept.length)
    if (perSource >= MIN_SOURCE_CHARS || kept.length === 1) {
      const block = kept
        .map((s, i) => `<result index=${i + 1} title="${s.title}" url="${s.url}">${s.content.slice(0, Math.max(0, perSource))}</result>`)
        .join('\n')
      return { block, used: kept.length }
    }
    kept = kept.slice(0, -1)
  }
  return { block: '', used: 0 }
}

/** Writes the final thorough-mode answer from the gathered sources.
 *
 *  Takes `customPrompt` and `memoryBlock` because this pass — not the researcher — produces the
 *  entire visible answer in thorough mode. Without them a user instruction like "always answer in
 *  Swedish" is honoured everywhere except the mode where it matters most. */
export function runWriter(
  sources: SearchResult[],
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  researcherNotes?: string,
  abortSignal?: AbortSignal,
  { customPrompt, memoryBlock }: { customPrompt?: string; memoryBlock?: string } = {},
) {
  let system = WRITER_SYSTEM
  if (memoryBlock) system += '\n\n' + memoryBlock
  if (customPrompt?.trim()) system += `\n\nAdditional instructions from the user:\n${customPrompt.trim()}`

  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  // The notes cite the researcher's own index values, which no longer match: sources are
  // renumbered from 1 below, after dedup and reranking. Left in, the writer copies a stale [7]
  // that now points at a different source — a citation that looks verified and isn't.
  const notes = researcherNotes?.replace(/\[\d+\]/g, '').trim()
  const notesBlock = notes ? `\n\nResearcher notes:\n${notes}` : ''
  const question = `\n\nQuestion: ${lastUser?.content ?? ''}`

  // Everything except the sources block is fixed cost; the sources absorb whatever is left.
  const ctxLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
  const budget = contextCharBudget(ctxLimit) - system.length - notesBlock.length - question.length - 'Research results:\n'.length
  const { block: sourcesBlock, used } = fitSources(sources, Math.max(0, budget))
  if (used < sources.length) {
    console.warn(`  [writer] sources trimmed to fit context: ${used}/${sources.length} kept (budget ${Math.max(0, budget)}c)`)
  }

  const userContent = `Research results:\n${sourcesBlock}${notesBlock}${question}`

  return streamText({
    model: getChatModel(),
    abortSignal,
    system,
    messages: [{ role: 'user', content: userContent }],
    maxOutputTokens: RESEARCH_MAX_TOKENS,
  })
}
