import type { TextStreamPart, ToolSet } from 'ai'
import type { SearchResult } from './searxng.ts'
import type { ThinkExtractor } from './think-extractor.ts'
import { stepEvent } from './progress.ts'

/** The SSE surface the drain needs. Kept minimal so non-interactive callers (the monitor
 *  executor) can pass `nullStream` instead of inventing a connection. */
export type SSEStream = {
  writeSSE: (opts: { data: string }) => Promise<void>
  /** Keepalive tick. Deliberately not recorded for resume: a ping carries nothing to replay,
   *  and the client counts recorded events to know where to resume from, so buffering pings
   *  would drift that cursor against the connection-local pings the resume route sends. */
  ping: () => Promise<void>
}

/** Discards everything written to it, for callers with no client attached. */
export const nullStream: SSEStream = {
  writeSSE: async () => {},
  ping: async () => {},
}

/** The SDK's own stream-part union, rather than a hand-written structural type. This is what
 *  made the v4 -> v7 upgrade tractable: the SDK renamed `textDelta` to `text` and tool
 *  `args`/`result` to `input`/`output`, and a structural cast would have kept compiling while
 *  silently yielding `undefined` — empty answers with a green typecheck. Keep it typed so the
 *  compiler finds the next one. See chat-stream.test.ts for the runtime counterpart. */
export type ResearcherStreamPart<TOOLS extends ToolSet = ToolSet> = TextStreamPart<TOOLS>

/** Tool-call input arrives typed as `unknown` under a generic ToolSet, so narrow once here
 *  rather than casting at each use. (`args` in ai@4; `input` from v5 on.) */
function toolArgs(part: { input: unknown }): { queries?: string[]; query?: string } {
  return (part.input ?? {}) as { queries?: string[]; query?: string }
}

/** Drains a researcher fullStream, routing parts to the appropriate outputs.
 *  onText receives extracted text content (researcher notes or answer text).
 *  onSources receives web_search tool results.
 *  Set emitTextAsThinking=true (thorough researcher) to mirror text into the thinking channel. */
export async function drainResearcherStream<TOOLS extends ToolSet>(
  researcherResult: { stream: AsyncIterable<ResearcherStreamPart<TOOLS>> },
  {
    stream, showThinking, emitSearchStatus, extractor, onText, onSources, emitTextAsThinking = false, maxSteps,
  }: {
    stream: SSEStream
    showThinking: boolean
    emitSearchStatus: (args: { queries?: string[]; query?: string }) => void | Promise<void>
    extractor: ThinkExtractor | null
    onText: (text: string) => void | Promise<void>
    onSources: (results: SearchResult[]) => void | Promise<void>
    emitTextAsThinking?: boolean
    /** Only for the "step N of M" label; omit when the cap is not known to the caller. */
    maxSteps?: number
  },
): Promise<string> {
  const emitThinking = (delta: string) =>
    stream.writeSSE({ data: JSON.stringify({ type: 'thinking', delta }) })

  let textDeltaCount = 0, reasoningCount = 0, finishReason = 'unknown'
  let stepIndex = 0
  for await (const part of researcherResult.stream) {
    if (part.type === 'finish' || part.type === 'finish-step') {
      if (part.finishReason) finishReason = part.finishReason
    } else if (part.type === 'start-step') {
      // The long silences are here, not at the tool calls: each step is one full model
      // generation. Without this the log sits on the previous entry for 5-15s at a time.
      stepIndex++
      await stream.writeSSE({ data: stepEvent({ kind: 'reason', index: stepIndex, total: maxSteps }) })
    } else if (part.type === 'tool-call' && part.toolName === 'web_search') {
      const args = toolArgs(part)
      await emitSearchStatus(args)
      if (showThinking) {
        const queries: string[] = args.queries ?? (args.query ? [args.query] : [])
        await emitThinking(`🔍 Searching: ${queries.map((q: string) => `"${q}"`).join(', ')}\n`)
      }
    } else if (part.type === 'tool-call' && part.toolName === 'uploads_search') {
      console.log(`  [uploads_search] query: ${JSON.stringify(toolArgs(part).query ?? '')}`)
    } else if (part.type === 'tool-result' && part.toolName === 'uploads_search') {
      const results = part.output as Array<{ filename?: string; content?: string }> | undefined
      console.log(`  [uploads_search] returned ${results?.length ?? 0} chunks`)
    } else if (part.type === 'tool-call' && part.toolName === 'save_to_memory') {
      await stream.writeSSE({ data: stepEvent({ kind: 'memory' }) })
    } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
      // result may be a non-array "search unavailable" message when search is exhausted.
      const results = (Array.isArray(part.output) ? part.output : []) as SearchResult[]
      await stream.writeSSE({ data: stepEvent({ kind: 'results', count: results.length }) })
      await onSources(results)
      if (showThinking) {
        const snippets = results.slice(0, 3)
          .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
          .join('\n')
        await emitThinking(snippets + '\n\n')
      }
    } else if (part.type === 'reasoning-delta') {
      reasoningCount++
      if (showThinking) await emitThinking(part.text)
    } else if (part.type === 'text-delta') {
      textDeltaCount++
      if (extractor) {
        const { text, thinking } = extractor.process(part.text)
        if (thinking && showThinking) await emitThinking(thinking)
        if (text) {
          if (emitTextAsThinking && showThinking) await emitThinking(text)
          await onText(text)
        }
      } else {
        if (emitTextAsThinking && showThinking) await emitThinking(part.text)
        await onText(part.text)
      }
    } else if (part.type === 'error') {
      console.error('  [researcher] stream error:', part.error)
    }
  }
  if (extractor) {
    const { text, thinking } = extractor.flush()
    if (thinking && showThinking) await emitThinking(thinking)
    if (text) {
      if (emitTextAsThinking && showThinking) await emitThinking(text)
      await onText(text)
    }
  }
  console.log(`  [drain] textDelta=${textDeltaCount} reasoning=${reasoningCount} finishReason=${finishReason}`)
  return finishReason
}
