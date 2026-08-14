import { generateText } from 'ai'
import type { ModelMessage } from 'ai'
import { getSmallModel, SMALL_MODEL_INPUT_CHARS, CHARS_PER_TOKEN, estimateTokens as estimate } from './llm.ts'

// Fraction of the model's context window budgeted for input (system + history + tool content);
// the remainder is reserved for the model's own output.
export const CONTEXT_RESERVE_FRACTION = 0.8

// Converts a token-based context limit into a char budget, using the same ratio as estimate().
export function contextCharBudget(ctxLimitTokens: number, fraction = CONTEXT_RESERVE_FRACTION): number {
  return ctxLimitTokens * fraction * CHARS_PER_TOKEN
}

// Below this many chars, compressing dropped history into a summary isn't worth an LLM call —
// fall back to a plain hard-drop instead (mirrors summarizeContent's truncation fallback).
const MIN_COMPRESS_CHARS = 300
// Fixed cap on serial small-model chunks per compression call (mirrors FETCH_SUMMARIZE_MAX_CHUNKS'
// default; not separately env-configurable — compression is already gated by its own admin toggle).
const MAX_HISTORY_COMPRESS_CHUNKS = 6

interface TrimSplit {
  kept: ModelMessage[]
  dropped: ModelMessage[]
  systemCost: number
  budget: number
}

// Shared core: decides which oldest messages (plus any orphaned leading tool results) must be
// dropped to fit `messages` within `maxTokens`, reserving `systemCost` tokens for systemPrompt.
// Pure/sync. Used by both trimMessages (hard-drop) and compressMessages (summarize-then-fold).
function splitForTrim(messages: ModelMessage[], maxTokens: number, systemPrompt: string): TrimSplit {
  const systemCost = estimate(systemPrompt)
  const budget = maxTokens - systemCost
  if (budget <= 0) return { kept: messages.slice(-1), dropped: messages.slice(0, -1), systemCost, budget }

  let total = messages.reduce((sum, m) => sum + estimate(JSON.stringify(m)), 0)
  if (total <= budget) return { kept: messages, dropped: [], systemCost, budget }

  let start = 0
  while (total > budget && start < messages.length - 1) {
    total -= estimate(JSON.stringify(messages[start]))
    start++
    // Drop orphaned tool results at the front, but never the last message
    while (start < messages.length - 1 && messages[start].role === 'tool') {
      total -= estimate(JSON.stringify(messages[start]))
      start++
    }
  }
  const trimmed = messages.slice(start)
  // Strip any leading tool message left orphaned after its tool-call was dropped
  const firstNonTool = trimmed.findIndex(m => m.role !== 'tool')
  const kept = firstNonTool > 0 ? trimmed.slice(firstNonTool) : trimmed
  const dropped = messages.slice(0, messages.length - kept.length)
  return { kept, dropped, systemCost, budget }
}

// Trims oldest messages so estimated tokens fit within maxTokens.
// Pass systemPrompt so its cost is reserved from the budget.
export function trimMessages(messages: ModelMessage[], maxTokens: number, systemPrompt = ''): ModelMessage[] {
  const { kept, dropped, systemCost, budget } = splitForTrim(messages, maxTokens, systemPrompt)
  if (budget <= 0) {
    console.warn(`[chat] system prompt alone (~${systemCost} tok) exceeds context budget ${maxTokens}`)
    return kept
  }
  if (dropped.length === 0) return messages
  console.warn(`[chat] context trim: dropped first ${dropped.length} messages (system ~${systemCost} tok, budget ${budget} tok)`)
  return kept
}

export interface CompressResult {
  messages: ModelMessage[]
  /** Present only when messages were dropped AND successfully compressed into a summary. */
  summary?: string
}

// Async sibling of trimMessages for the agentic researcher path: when messages must be dropped,
// summarizes the dropped chunk with the small model instead of discarding it, returning the
// summary separately so the caller can fold it into the system prompt (folding into messages[]
// itself is unsafe — ModelMessage[] role-alternation/tool-pairing constraints make inserting a
// synthetic mid-array message risky; the system string is a single always-present slot that's
// safe to append to). Chunks the dropped content against the small model's own context window
// (SMALL_MODEL_INPUT_CHARS), exactly like summarizeContent does for oversized URL content — if the
// dropped range is larger than MAX_HISTORY_COMPRESS_CHUNKS chunks can cover, only the most recent
// slice of it (closest to the current topic) is summarized; the oldest remainder is dropped
// entirely rather than partially represented. Falls back to a plain hard-drop on any generateText
// failure or when the summary budget is too small to be worthwhile.
export async function compressMessages(
  messages: ModelMessage[],
  maxTokens: number,
  systemPrompt: string,
  summaryBudgetChars: number,
): Promise<CompressResult> {
  const { kept, dropped, systemCost, budget } = splitForTrim(messages, maxTokens, systemPrompt)
  if (budget <= 0) {
    console.warn(`[chat] system prompt alone (~${systemCost} tok) exceeds context budget ${maxTokens}`)
    return { messages: kept }
  }
  if (dropped.length === 0) return { messages }
  if (summaryBudgetChars < MIN_COMPRESS_CHARS) {
    console.warn(`[chat] context trim: dropped first ${dropped.length} messages (system ~${systemCost} tok, budget ${budget} tok) — summary budget too small (${summaryBudgetChars}c), hard-dropped`)
    return { messages: kept }
  }

  const start = performance.now()
  const fullInput = dropped.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n')
  const maxInputChars = MAX_HISTORY_COMPRESS_CHUNKS * SMALL_MODEL_INPUT_CHARS
  const input = fullInput.length > maxInputChars ? fullInput.slice(fullInput.length - maxInputChars) : fullInput
  if (fullInput.length > maxInputChars) {
    console.log(`  [chat] history compression: dropped range too large (${fullInput.length}c) for ${MAX_HISTORY_COMPRESS_CHUNKS} chunks — summarizing only the most recent ${maxInputChars}c`)
  }
  const numChunks = Math.min(MAX_HISTORY_COMPRESS_CHUNKS, Math.ceil(input.length / SMALL_MODEL_INPUT_CHARS))
  const perChunkChars = Math.floor(summaryBudgetChars / numChunks)
  try {
    const summaries: string[] = []
    for (let i = 0; i < numChunks; i++) {
      const chunk = input.slice(i * SMALL_MODEL_INPUT_CHARS, (i + 1) * SMALL_MODEL_INPUT_CHARS)
      const { text } = await generateText({
        model: getSmallModel(),
        system: `You are compacting an earlier portion of a long conversation so it can be dropped from the active context without losing important information.
1. Preserve names, decisions, facts, and numbers a later turn might refer back to.
2. Omit pleasantries, repeated context, and anything superseded by a later message.
3. Write as a compact third-person briefing note, not a transcript.
Output ONLY the summary, no preamble. Target approximately ${perChunkChars} characters.`,
        prompt: chunk,
        maxOutputTokens: Math.ceil(perChunkChars / CHARS_PER_TOKEN),
      })
      summaries.push(text.trim())
    }
    const summary = summaries.join('\n')
    console.log(`  [chat] history compressed: dropped ${dropped.length} messages (${input.length}c, ${numChunks} chunk(s)) → summary ${summary.length}c in ${(performance.now() - start).toFixed(0)}ms`)
    return { messages: kept, summary }
  } catch (err) {
    console.warn(`[chat] context trim: dropped first ${dropped.length} messages (system ~${systemCost} tok, budget ${budget} tok) — compression failed (${err}), hard-dropped`)
    return { messages: kept }
  }
}
