import { runFlashTurn } from './flash.ts'
import { runImageTurn } from './image.ts'
import { runResearchTurn } from './research.ts'
import type { TurnContext, TurnResult, TurnSink } from './context.ts'

export * from './context.ts'
export { toSearxngCategories } from './prepare.ts'
export { toStoredSource } from './research.ts'

/** Runs one turn in its focus mode, writing events to `sink`; the caller emits `session` first and persists after. */
export function runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  switch (ctx.focusMode) {
    case 'flash': return runFlashTurn(ctx, sink)
    case 'image': return runImageTurn(ctx, sink)
    default: return runResearchTurn(ctx, sink)
  }
}
