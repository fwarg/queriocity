import { generateText } from 'ai'
import type { ModelMessage } from 'ai'
import type { ContextReport } from '../../shared/context.ts'
import { getSmallModel, SMALL_MODEL_INPUT_CHARS, CHARS_PER_TOKEN, estimateTokens as estimate, tokensToChars } from './llm.ts'

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

/** No message pinned. */
const NO_PINS: ReadonlySet<number> = new Set()
// A pinned message is shortened to fit rather than dropped, but never below this: the question
// and the start of its document stay readable.
const MIN_PINNED_CHARS = 1000
const TRUNCATED_NOTE = '\n\n[…truncated to fit the context window]'

interface TrimSplit {
  kept: ModelMessage[]
  dropped: ModelMessage[]
  /** Request indices of `dropped`, ascending. */
  droppedIdx: number[]
  systemCost: number
  budget: number
  report: ContextReport
}

const costOf = (m: ModelMessage) => estimate(JSON.stringify(m))

/** A tool call or its result: search results and pages, not conversation. */
const isToolExchange = (m: ModelMessage) =>
  m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(p => p.type === 'tool-call'))

// Shared core: decides which oldest unpinned messages (plus any tool results orphaned by that)
// must be dropped to fit `messages` within `maxTokens`, reserving `systemCost` tokens for
// systemPrompt. Pinned messages are kept, shortened if they alone overflow; the last message is
// always kept. Pure/sync. Used by both trimMessages (hard-drop) and compressMessages.
function splitForTrim(messages: ModelMessage[], maxTokens: number, systemPrompt: string, pinned = NO_PINS): TrimSplit {
  const systemCost = estimate(systemPrompt)
  const budget = maxTokens - systemCost
  const last = messages.length - 1
  const drop = new Set<number>()
  let current = messages
  if (budget <= 0) {
    for (let i = 0; i < last; i++) drop.add(i)
  } else {
    const cost = messages.map(costOf)
    let total = cost.reduce((a, b) => a + b, 0)
    for (let i = 0; i < last && total > budget; i++) {
      if (pinned.has(i)) continue
      drop.add(i)
      total -= cost[i]
      // A tool result is meaningless without the call it answers, but never drop the last message
      while (i + 1 < last && messages[i + 1].role === 'tool') {
        drop.add(++i)
        total -= cost[i]
      }
    }
    if (total > budget) current = shortenPinned(messages, pinned, last, total - budget)
  }
  const droppedIdx = [...drop].sort((a, b) => a - b)
  const kept = current.filter((_, i) => !drop.has(i))
  const dropped = droppedIdx.map(i => messages[i])
  const report = reportFor(current, drop, droppedIdx, pinned, maxTokens, systemPrompt.length, current !== messages)
  return { kept, dropped, droppedIdx, systemCost, budget, report }
}

/** Shortens pinned messages, oldest first, by `excessTokens` in total. Returns a new array. */
function shortenPinned(messages: ModelMessage[], pinned: ReadonlySet<number>, last: number, excessTokens: number): ModelMessage[] {
  let excessChars = excessTokens * CHARS_PER_TOKEN
  const out = [...messages]
  for (const i of [...pinned].sort((a, b) => a - b)) {
    const m = out[i]
    if (i >= last || excessChars <= 0 || !m || typeof m.content !== 'string') continue
    const cut = Math.min(excessChars, m.content.length - MIN_PINNED_CHARS)
    if (cut <= 0) continue
    out[i] = { ...m, content: m.content.slice(0, m.content.length - cut) + TRUNCATED_NOTE } as ModelMessage
    excessChars -= cut
  }
  return out
}

function reportFor(
  messages: ModelMessage[], drop: Set<number>, droppedIdx: number[], pinned: ReadonlySet<number>,
  maxTokens: number, systemChars: number, pinnedTruncated: boolean,
): ContextReport {
  let pinnedChars = 0
  let historyChars = 0
  let searchChars = 0
  messages.forEach((m, i) => {
    if (drop.has(i)) return
    const chars = JSON.stringify(m).length
    if (pinned.has(i)) pinnedChars += chars
    else if (isToolExchange(m)) searchChars += chars
    else historyChars += chars
  })
  const cut = droppedIdx.length ? droppedIdx[droppedIdx.length - 1] + 1 : 0
  return { budgetChars: tokensToChars(maxTokens), systemChars, pinnedChars, historyChars, summaryChars: 0, searchChars, cut, lostBefore: cut, pinnedTruncated }
}

export interface TrimResult {
  messages: ModelMessage[]
  report: ContextReport
}

// Trims oldest unpinned messages so estimated tokens fit within maxTokens.
// Pass systemPrompt so its cost is reserved from the budget.
export function trimMessages(messages: ModelMessage[], maxTokens: number, systemPrompt = '', pinned = NO_PINS): TrimResult {
  const { kept, dropped, systemCost, budget, report } = splitForTrim(messages, maxTokens, systemPrompt, pinned)
  if (budget <= 0) console.warn(`[chat] system prompt alone (~${systemCost} tok) exceeds context budget ${maxTokens}`)
  else if (dropped.length > 0) console.warn(`[chat] context trim: dropped ${dropped.length} oldest messages (system ~${systemCost} tok, budget ${budget} tok${pinned.size ? `, ${pinned.size} pinned kept` : ''})`)
  if (report.pinnedTruncated) console.warn(`[chat] context trim: pinned messages alone exceed the budget — shortened`)
  return { messages: kept, report }
}

export interface CompressResult extends TrimResult {
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
// failure or when the summary budget is too small to be worthwhile. Pinned messages are never
// dropped, so never summarized.
export async function compressMessages(
  messages: ModelMessage[],
  maxTokens: number,
  systemPrompt: string,
  summaryBudgetChars: number,
  pinned = NO_PINS,
): Promise<CompressResult> {
  const { kept, dropped, droppedIdx, systemCost, budget, report } = splitForTrim(messages, maxTokens, systemPrompt, pinned)
  const hardDrop = (why: string) => {
    console.warn(`[chat] context trim: dropped ${dropped.length} oldest messages (system ~${systemCost} tok, budget ${budget} tok) — ${why}, hard-dropped`)
    return { messages: kept, report }
  }
  if (budget <= 0) {
    console.warn(`[chat] system prompt alone (~${systemCost} tok) exceeds context budget ${maxTokens}`)
    return { messages: kept, report }
  }
  if (dropped.length === 0) return { messages: kept, report }
  if (summaryBudgetChars < MIN_COMPRESS_CHARS) return hardDrop(`summary budget too small (${summaryBudgetChars}c)`)

  const start = performance.now()
  const parts = dropped.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
  const fullInput = parts.join('\n\n')
  const maxInputChars = MAX_HISTORY_COMPRESS_CHUNKS * SMALL_MODEL_INPUT_CHARS
  const input = fullInput.length > maxInputChars ? fullInput.slice(fullInput.length - maxInputChars) : fullInput
  if (fullInput.length > maxInputChars) {
    console.log(`  [chat] history compression: dropped range too large (${fullInput.length}c) for ${MAX_HISTORY_COMPRESS_CHUNKS} chunks — summarizing only the most recent ${maxInputChars}c`)
  }
  try {
    const summary = await summarizeHistory(input, summaryBudgetChars)
    const lost = lostCount(parts, fullInput.length - input.length)
    console.log(`  [chat] history compressed: dropped ${dropped.length} messages (${input.length}c) → summary ${summary.length}c in ${(performance.now() - start).toFixed(0)}ms`)
    return {
      messages: kept,
      summary,
      report: { ...report, summary, summaryChars: summary.length, lostBefore: lost ? droppedIdx[lost - 1] + 1 : 0 },
    }
  } catch (err) {
    return hardDrop(`compression failed (${err})`)
  }
}

/** How many of the leading dropped messages fall wholly before `sliceStart`, outside the summary. */
function lostCount(parts: string[], sliceStart: number): number {
  let offset = 0
  let lost = 0
  for (const part of parts) {
    if (offset + part.length > sliceStart) break
    lost++
    offset += part.length + 2  // the '\n\n' separator
  }
  return lost
}

/** Summarizes `input` in serial small-model chunks, to roughly `budgetChars` in total. */
async function summarizeHistory(input: string, budgetChars: number): Promise<string> {
  const numChunks = Math.min(MAX_HISTORY_COMPRESS_CHUNKS, Math.ceil(input.length / SMALL_MODEL_INPUT_CHARS))
  const perChunkChars = Math.floor(budgetChars / numChunks)
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
  return summaries.join('\n')
}
