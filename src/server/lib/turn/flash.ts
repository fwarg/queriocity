import { streamText } from 'ai'
import { languageModel, outputCap } from '../llm.ts'
import { FLASH_SYSTEM, FLASH_MAX_TOKENS } from '../answer.ts'
import { memoryTokenBudget, notesRagBudget, spaceRagBudget } from '../rag-settings.ts'
import { buildMemoryBlock, buildCollectionBlock, buildNotesBlock, userMemoryBlockIfEnabled, joinMemoryBlocks } from '../memory/index.ts'
import { trimMessages, CONTEXT_RESERVE_FRACTION } from '../trim-messages.ts'
import { collectionRagBudget } from './prepare.ts'
import { AnswerStream } from './stream-answer.ts'
import { userQueryOf, withInstructions, type TurnContext, type TurnResult, type TurnSink } from './context.ts'

/** Flash mode: one model call, no search, answering from memory and picked documents only. */
export async function runFlashTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  const t0 = Date.now()
  // Plain status rather than a log step: flash has exactly one phase, so a log of it would
  // be a list of length one. The client pairs this with a ticking timer.
  await sink.emit({ type: 'status', text: 'Thinking…' })
  const { block, fileSources } = await flashBlocks(ctx)
  if (fileSources.length > 0) await sink.emit({ type: 'file_sources', sources: fileSources })
  const system = FLASH_SYSTEM
    + withInstructions(ctx)
    + (block ? '\n\n' + block : '')
  const history = trimMessages(ctx.msgs, Math.floor(ctx.models.flash.contextTokens * CONTEXT_RESERVE_FRACTION), system, ctx.pinned)
  await sink.context(history.report)
  const result = streamText({
    model: languageModel(ctx.models.flash),
    abortSignal: ctx.abortSignal,
    system,
    messages: history.messages,
    maxOutputTokens: outputCap(ctx.models.flash, FLASH_MAX_TOKENS),
  })
  // Flash runs models.flash, which is the full chat model unless FLASH_MODEL=small — the
  // same reasoning-capable model whose <think> output the other modes strip. Flash has no
  // thinking channel, so the extracted thinking is discarded rather than shown.
  const content = await new AnswerStream(sink, { citations: false }).consume(result.stream)
  console.log(`  [flash] done in ${Date.now() - t0}ms, ${content.length} chars`)
  return { content, sources: [], fileSources, cacheable: true }
}

/** Memory, collection and notes context for flash; their sources ride along so [F1]/[C1] resolve. */
async function flashBlocks(ctx: TurnContext) {
  const query = userQueryOf(ctx.msgs)
  const [memoryBudget, ragBudget] = await Promise.all([
    ctx.spaceId ? memoryTokenBudget() : Promise.resolve(0),
    ctx.spaceId ? spaceRagBudget() : Promise.resolve(0),
  ])
  const effectiveRag = (ctx.settings.useSpaceRag !== false) ? ragBudget : 0
  const scoped = ctx.spaceId
    ? await buildMemoryBlock(ctx.spaceId, memoryBudget, effectiveRag, query, ctx.includeFileIds, ctx.includeMemoryIds, ctx.locked)
    : { block: '', fileSources: [] }
  // Collections are picked per request and apply with or without a space, so they get their own
  // budget rather than the space one — which is deliberately 0 for a chat that has no space.
  const collections = await buildCollectionBlock(ctx.collections, query, await collectionRagBudget(ctx.collections), ctx.locked)
  const notes = ctx.notesFirst ? await buildNotesBlock(ctx.userId, query, await notesRagBudget(), ctx.locked) : { block: '', fileSources: [] }
  return {
    block: joinMemoryBlocks(await userMemoryBlockIfEnabled(ctx.userId, ctx.settings, query), scoped.block, collections.block, notes.block),
    fileSources: [...scoped.fileSources, ...collections.fileSources, ...notes.fileSources],
  }
}
