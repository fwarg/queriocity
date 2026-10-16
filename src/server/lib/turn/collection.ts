import { streamText } from 'ai'
import { languageModel, outputCap, RESEARCH_MAX_TOKENS } from '../llm.ts'
import { userMemoryBlockIfEnabled, joinMemoryBlocks } from '../memory.ts'
import { coverCollection } from '../files/collection-coverage.ts'
import { trimMessages, meterBudgetChars, CONTEXT_RESERVE_FRACTION } from '../trim-messages.ts'
import { thinkingFor } from './prepare.ts'
import { AnswerStream } from './stream-answer.ts'
import { userQueryOf, withKeepalive, type TurnContext, type TurnResult, type TurnSink } from './context.ts'

const COLLECTION_SYSTEM = `You work on a collection of documents the user selected, all of which are given below, together with anything the user attaches to their message (for instance a draft of their own).
Do the task the user asks for, grounded in these documents. Do not invent what they do not say; say so when they do not cover something.
When you compare or assess, refer to each document by its label and be specific: name the claim, section or result you mean.
Use ## headings, lists and tables where they help. Always respond in the same language the user used.`

/** Room kept for earlier messages, which are trimmed to fit once the documents are in. */
const HISTORY_RESERVE_CHARS = 4000

/** Whole-collection mode: one answer call over every document in the picked collections.
 *
 *  No web search and no research loop: a tool loop resends the system prompt at every step, and
 *  here that prompt holds the collection, so each step would pay for every document again.
 *  Kept alive throughout: a local model can read for minutes before its first word, and a silent
 *  stream is dropped, after which the run is abandoned. */
export function runCollectionTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  return withKeepalive(sink, () => answerFromCollection(ctx, sink))
}

async function answerFromCollection(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  const t0 = Date.now()
  const model = answerModel(ctx)
  const query = userQueryOf(ctx.msgs)
  const head = joinMemoryBlocks(
    COLLECTION_SYSTEM + (ctx.customPrompt ? `\n\nAdditional instructions:\n${ctx.customPrompt}` : ''),
    await userMemoryBlockIfEnabled(ctx.userId, ctx.settings, query),
  )
  const coverage = await coverCollection(ctx.collections, {
    model,
    includeConfidential: ctx.locked,
    budgetChars: meterBudgetChars(model.contextTokens) - head.length - query.length - HISTORY_RESERVE_CHARS,
    abortSignal: ctx.abortSignal,
    // Digest progress rewrites one log row; nothing to wait for, so it is not awaited.
    onProgress: (index, total) => { void sink.step({ kind: 'documents', index, total, update: index > 0 }) },
  })
  if (coverage.fileSources.length) await sink.emit({ type: 'file_sources', sources: coverage.fileSources })
  // For the answer's footer, in place of the search results the other modes report.
  await sink.emit({ type: 'coverage', documents: coverage.fileSources.length, mode: coverage.mode, trimmed: coverage.trimmed })
  await sink.step({ kind: 'write' })
  const system = joinMemoryBlocks(head, coverage.block)
  const history = trimMessages(ctx.msgs, Math.floor(model.contextTokens * CONTEXT_RESERVE_FRACTION), system, ctx.pinned)
  await sink.context(history.report)
  const result = streamText({
    model: languageModel(model),
    abortSignal: ctx.abortSignal,
    system,
    messages: history.messages,
    maxOutputTokens: outputCap(model, RESEARCH_MAX_TOKENS),
  })
  const content = await new AnswerStream(sink, { citations: false, showThinking: thinkingFor(ctx).showThinking })
    .consume(result.stream, { reasoning: true })
  console.log(`  [collection] ${coverage.fileSources.length} documents (${coverage.mode}) in ${Date.now() - t0}ms, ${content.length} chars`)
  // Not cached: the collection's documents can change under the same question.
  return { content, sources: [], fileSources: coverage.fileSources, cacheable: false, answeredBy: model }
}

/** The model that answers, and so writes the digests: flash's model in flash, else as research picks it. */
const answerModel = (ctx: TurnContext) => ctx.focusMode === 'flash' ? ctx.models.flash : thinkingFor(ctx).researchModel
