import { streamText } from 'ai'
import { getNumberSetting } from '../db.ts'
import { languageModel, outputCap, tokensToChars, estimateTokens, researchMaxTokens, type ModelTarget } from '../llm.ts'
import { splitAttachments } from '../../../shared/context.ts'
import { userMemoryBlockIfEnabled, joinMemoryBlocks } from '../memory/index.ts'
import { coverCollection } from '../files/collection-coverage.ts'
import { trimMessages, meterBudgetChars, CONTEXT_RESERVE_FRACTION } from '../trim-messages.ts'
import { thinkingFor, spaceMemoryOnly } from './prepare.ts'
import { AnswerStream } from './stream-answer.ts'
import { userQueryOf, withInstructions, withKeepalive, documentSet, type TurnContext, type TurnResult, type TurnSink } from './context.ts'

const COLLECTION_SYSTEM = `You work on a collection of documents the user selected, all of which are given below, together with anything the user attaches to their message (for instance a draft of their own).
Do the task the user asks for, grounded in these documents. Do not invent what they do not say; say so when they do not cover something.
When you compare or assess, refer to each document by its label and be specific: name the claim, section or result you mean.
Use ## headings, lists and tables where they help. Always respond in the same language the user used.`

/** Room kept for earlier messages, which are trimmed to fit once the documents are in. */
const HISTORY_RESERVE_CHARS = 4000
/** Up to this many tokens a collection goes in full; above, each document is read for the task.
 *  Admin settings, since how long a full read takes depends on the model server: a local GPU slows
 *  sharply with prompt length, while a cloud model reads a long prompt quickly, and seeing every
 *  document side by side finds the links between them that reading one at a time misses. The model's
 *  own context caps both, so the cloud default amounts to "whatever fits". */
export const DEFAULT_COLLECTION_FULL_TEXT_TOKENS = 30000
export const DEFAULT_COLLECTION_FULL_TEXT_TOKENS_CLOUD = 1_000_000
/** The task when a message is only an attachment. */
const ATTACHMENT_ONLY_TASK = 'Review the attached document against the documents in the collection.'

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
    COLLECTION_SYSTEM + withInstructions(ctx),
    await userMemoryBlockIfEnabled(ctx.userId, ctx.settings, query),
    await spaceMemoryOnly(ctx, query),
  )
  const { text, attachments } = splitAttachments(query)
  const coverage = await coverCollection(documentSet(ctx), {
    model,
    task: text || ATTACHMENT_ONLY_TASK,
    draft: attachments || undefined,
    fullTextMaxChars: await fullTextMaxChars(model),
    includeConfidential: ctx.locked,
    budgetChars: meterBudgetChars(model.contextTokens) - head.length - query.length - HISTORY_RESERVE_CHARS,
    abortSignal: ctx.abortSignal,
    // Reading progress rewrites one log row; nothing to wait for, so it is not awaited.
    onProgress: (index, total) => { void sink.step({ kind: 'documents', index, total, update: index > 0 }) },
  })
  if (coverage.fileSources.length) await sink.emit({ type: 'file_sources', sources: coverage.fileSources })
  // For the answer's footer, in place of the search results the other modes report.
  await sink.emit({ type: 'coverage', documents: coverage.fileSources.length, mode: coverage.mode, trimmed: coverage.trimmed, irrelevant: coverage.irrelevant })
  const system = joinMemoryBlocks(head, coverage.block)
  // The model reads everything before its first word — minutes for a long prompt on a local GPU — so
  // that wait is a step of its own, and "writing" starts with the first output.
  const count = coverage.fileSources.length
  await sink.step(coverage.mode === 'full' ? { kind: 'readFull', count, total: estimateTokens(system) } : { kind: 'combine', count })
  const history = trimMessages(ctx.msgs, Math.floor(model.contextTokens * CONTEXT_RESERVE_FRACTION), system, ctx.pinned)
  await sink.context(history.report)
  const result = streamText({
    model: languageModel(model),
    abortSignal: ctx.abortSignal,
    system,
    messages: history.messages,
    maxOutputTokens: outputCap(model, researchMaxTokens()),
  })
  const content = await new AnswerStream(sink, { citations: false, showThinking: thinkingFor(ctx).showThinking })
    .consume(onFirstOutput(result.stream, () => sink.step({ kind: 'write' })), { reasoning: true })
  console.log(`  [collection] ${coverage.fileSources.length} documents (${coverage.mode}) in ${Date.now() - t0}ms, ${content.length} chars`)
  // Not cached: the collection's documents can change under the same question.
  return { content, sources: [], fileSources: coverage.fileSources, cacheable: false, answeredBy: model }
}

/** Passes a model stream through, calling `fn` once at its first text or reasoning. */
async function* onFirstOutput<P extends { type: string }>(stream: AsyncIterable<P>, fn: () => Promise<void>): AsyncIterable<P> {
  let started = false
  for await (const part of stream) {
    if (!started && (part.type === 'text-delta' || part.type === 'reasoning-delta')) {
      started = true
      await fn()
    }
    yield part
  }
}

/** The full-text threshold for this model: the cloud one for a cloud (metered) model, else the local one. */
async function fullTextMaxChars(model: ModelTarget): Promise<number> {
  const tokens = model.onUsage
    ? await getNumberSetting('collection_full_text_tokens_cloud', DEFAULT_COLLECTION_FULL_TEXT_TOKENS_CLOUD)
    : await getNumberSetting('collection_full_text_tokens', DEFAULT_COLLECTION_FULL_TEXT_TOKENS)
  return tokensToChars(tokens)
}

/** The model that answers, and so reads each document: flash's model in flash, else as research picks it. */
const answerModel = (ctx: TurnContext) => ctx.focusMode === 'flash' ? ctx.models.flash : thinkingFor(ctx).researchModel
