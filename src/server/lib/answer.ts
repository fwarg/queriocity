import { streamText } from 'ai'
import { languageModel, outputCap, researchMaxTokens, type ModelTarget } from './llm.ts'
import type { SearchResult } from './search/index.ts'

/** Pieces shared by every path that produces an answer — the interactive chat route and the
 *  non-interactive monitor/RSS executor. They ran private copies of all of this, and the copies
 *  drifted: the executor's synthesis prompt had lost the anti-refusal clauses, and fixes to one
 *  path routinely missed the other. */

/** Flash mode: a short answer from the model's own knowledge, streamed as Markdown; no tools, no sources. */
export const FLASH_SYSTEM = `Answer in at most 5 sentences using only your training knowledge. Be direct and factual.
Do not search the web. If you cannot answer confidently, say so briefly.
Always respond in the same language the user used.`

/** Output: the answer as Markdown with inline [N] citations; the search results and memory are appended
 *  after this text by the caller. */
const answerFromResultsSystem = (today: string) => `Today's date is ${today}. Synthesize the search results below into a direct answer with inline [N] citations using the index values shown.
Do NOT say you lack internet access, and do NOT decline to answer: the results below are what the search returned, and reporting them partially is far more useful than refusing.
If they only partially cover the question, answer with whatever they do support and close with one short line naming what was missing. Never reply with only a refusal.
Search results are authoritative ground truth — if they describe a product or release you don't recognise, trust them; your training data has a cutoff.`

// 200 was too tight against FLASH_SYSTEM's "at most 5 sentences" — a dense answer hit the cap
// mid-sentence with nothing to show for it. Raised to leave headroom for the requested length,
// including the reasoning tokens a thinking-capable flash model spends before it writes.
// Lives beside FLASH_SYSTEM because it is part of the same contract: the monitor executor kept a
// separate literal 200 and truncated digests the interactive path had already stopped truncating.
export const FLASH_MAX_TOKENS = parseInt(process.env.FLASH_MAX_TOKENS ?? '400')

/** Cap on researcher notes handed to the writer — beyond this they crowd out the sources. */
export const RESEARCHER_NOTES_CAP = 12000

/** Shown as the answer when the model produced nothing the whole way down, fallback included.
 *  Sending it as answer text rather than a status is deliberate: an empty `done` is
 *  indistinguishable from a dead server on the client, so the failure has to name itself. */
export const EMPTY_ANSWER_MESSAGE = 'The model returned an empty response — it produced no answer text on either the main pass or the fallback. Try again, or restart the model server if it repeats.'

/** Chars of each result carried into the synthesis prompt. */
const SYNTHESIS_SNIPPET_CHARS = 500

/** Last-resort answer pass with no tools, for when the researcher ends without producing prose —
 *  either because it spent its steps on tool calls, or because everything it emitted was markup
 *  the extractor dropped. Deliberately insistent about not refusing: the model is being handed
 *  results it may not recognise, and its instinct is to disclaim rather than report them. */
export function runSynthesisFallback({ model, results, messages, memoryBlock, abortSignal }: {
  model: ModelTarget
  results: SearchResult[]
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  memoryBlock?: string
  abortSignal?: AbortSignal
}) {
  const resultsBlock = results.length > 0
    ? '\n\nSearch results:\n' + results.map((r, i) => {
        const idx = (r as SearchResult & { index?: number }).index ?? (i + 1)
        return `[${idx}] ${r.title}\n${r.url}\n${r.content.slice(0, SYNTHESIS_SNIPPET_CHARS)}`
      }).join('\n\n')
    : ''

  return streamText({
    model: languageModel(model),
    system: `${answerFromResultsSystem(new Date().toISOString().split('T')[0])}${resultsBlock}${memoryBlock ? '\n\n' + memoryBlock : ''}`,
    messages,
    abortSignal,
    maxOutputTokens: outputCap(model, researchMaxTokens()),
  })
}
