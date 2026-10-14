/** Per-call metering for cloud models: token counts from the AI SDK, plus what the provider itself
 *  reports — its own cost figure and the hosting provider a routing service picked — which the SDK
 *  drops, so they are read from the raw response. */

import type { LanguageModelMiddleware } from 'ai'
import { CHARS_PER_TOKEN } from './llm.ts'

export interface TokenUsage {
  inputTokens: number
  /** Includes reasoning tokens, which providers bill as output. */
  outputTokens: number
  /** Cost as the provider reported it, in the provider's own unit; absent when it reports none. */
  reportedCost?: number
  /** The hosting provider a routing service sent the call to, when it says. */
  routedVia?: string
  /** The call was cut off before the provider reported usage; the counts are an estimate. */
  estimated?: boolean
}

/** What one model instance's latest response reported. One instance runs its calls one after
 *  another (each step of a tool loop waits for the last), so the latest response is the call
 *  whose finish is being reported. */
export interface ResponseProbe {
  cost?: number
  via?: string
}

/** Response headers that name the hosting provider: Cortecs. OpenRouter says it in the body. */
const ROUTED_VIA_HEADERS = ['x-cortecs-provider']

/** Notes the cost and routing a response reports, without changing what the SDK receives. */
export async function observeResponse(res: Response, probe: ResponseProbe): Promise<Response> {
  probe.via = ROUTED_VIA_HEADERS.map(h => res.headers.get(h)).find(Boolean) ?? probe.via
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    readReport(await res.clone().json().catch(() => null), probe)
    return res
  }
  if (!type.includes('event-stream') || !res.body) return res
  // Inspected in passing, chunk by chunk, so the usage chunk is read before the SDK reports the finish.
  const decoder = new TextDecoder()
  let pending = ''
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) readSseLine(line, probe)
      controller.enqueue(chunk)
    },
  }))
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

function readSseLine(line: string, probe: ResponseProbe) {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') return
  try { readReport(JSON.parse(line.slice(6)), probe) } catch { /* not JSON: nothing to read */ }
}

/** `usage.cost` (Cortecs, OpenRouter) and a top-level `provider` (OpenRouter), where present. */
function readReport(json: unknown, probe: ResponseProbe) {
  const body = json as { usage?: { cost?: unknown }; provider?: unknown } | null
  if (typeof body?.usage?.cost === 'number') probe.cost = body.usage.cost
  if (typeof body?.provider === 'string' && body.provider) probe.via = body.provider
}

/** Hooks for a metered model's calls. */
export interface MeterHooks {
  onUsage: (u: TokenUsage) => void
  /** A call failed; the message is the provider's, for the user to see. */
  onError?: (message: string) => void
}

/** A model stream part, taken from the middleware type so the provider package need not be a dependency. */
type StreamPart = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapStream']>>>['stream'] extends ReadableStream<infer P> ? P : never
const REASONING_ID = 'provider-reasoning'

/** Reports each call's usage once it is known: from the result, or from a stream's finish part.
 *  At the model layer rather than per call site, so every step of a tool loop is counted. A
 *  stream cut off before its finish part (stopped, timed out, failed) is still billed by the
 *  provider, so it is reported with an estimate from the prompt and the text received. */
export function usageMiddleware({ onUsage, onError }: MeterHooks, probe: ResponseProbe): LanguageModelMiddleware {
  const report = (inputTokens: number, outputTokens: number, estimated = false) => {
    try {
      onUsage({ inputTokens, outputTokens, reportedCost: probe.cost, routedVia: probe.via, ...(estimated && { estimated }) })
    } catch (e) {
      console.error('  [llm] usage recording failed:', e)
    }
    // A step that reports no cost must not inherit the previous step's.
    probe.cost = undefined
  }
  // A stop or timeout is the caller's doing, not the provider failing.
  const failed = (e: unknown) => { if (!isAbort(e)) onError?.(errorText(e)) }
  return {
    specificationVersion: 'v4',
    // Raw chunks carry the reasoning the SDK's chat model drops; see reasoningFromRaw.
    transformParams: async ({ params, type }) => type === 'stream' ? { ...params, includeRawChunks: true } : params,
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        const result = await doGenerate()
        report(result.usage.inputTokens.total ?? 0, result.usage.outputTokens.total ?? 0)
        return result
      } catch (e) {
        failed(e)
        // A refused request is not billed; one stopped while the provider worked on it may be.
        if (isAbort(e)) report(estimateTokens(params.prompt), 0, true)
        throw e
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        const result = await doStream()
        return { ...result, stream: meteredStream(result.stream, estimateTokens(params.prompt), report, failed) }
      } catch (e) {
        failed(e)
        // A refused request is not billed; one stopped while the provider worked on it may be.
        if (isAbort(e)) report(estimateTokens(params.prompt), 0, true)
        throw e
      }
    },
  }
}

/** Passes a model stream through: turns raw chunks into reasoning parts, reports usage at the
 *  finish, and reports an estimate if the stream ends any other way. */
function meteredStream(
  source: ReadableStream<StreamPart>,
  promptTokens: number,
  report: (input: number, output: number, estimated?: boolean) => void,
  failed: (e: unknown) => void,
): ReadableStream<StreamPart> {
  const reader = source.getReader()
  let finished = false
  let outputChars = 0
  let reasoningOpen = false
  // Set once the SDK emits reasoning itself, so the raw chunks are not read for it twice.
  let sdkReasoning = false
  const reportCutOff = () => {
    if (finished) return
    finished = true
    report(promptTokens, Math.ceil(outputChars / CHARS_PER_TOKEN), true)
  }
  const closeReasoning = (controller: ReadableStreamDefaultController<StreamPart>) => {
    if (!reasoningOpen) return
    reasoningOpen = false
    controller.enqueue({ type: 'reasoning-end', id: REASONING_ID })
  }
  /** Handles one source part; false when it produced nothing for the consumer. */
  const forward = (part: StreamPart, controller: ReadableStreamDefaultController<StreamPart>): boolean => {
    if (part.type === 'raw') {
      const reasoning = sdkReasoning ? '' : reasoningFromRaw(part.rawValue)
      if (!reasoning) return false
      if (!reasoningOpen) { reasoningOpen = true; controller.enqueue({ type: 'reasoning-start', id: REASONING_ID }) }
      outputChars += reasoning.length
      controller.enqueue({ type: 'reasoning-delta', id: REASONING_ID, delta: reasoning })
      return true
    }
    if (part.type === 'reasoning-delta') { sdkReasoning = true; outputChars += part.delta.length }
    else closeReasoning(controller)
    if (part.type === 'text-delta') outputChars += part.delta.length
    if (part.type === 'error') failed(part.error)
    if (part.type === 'finish') { finished = true; report(part.usage.inputTokens.total ?? 0, part.usage.outputTokens.total ?? 0) }
    controller.enqueue(part)
    return true
  }
  return new ReadableStream<StreamPart>({
    // Reads on until something is produced: a pull that enqueues nothing is not called again.
    async pull(controller) {
      for (;;) {
        let next: Awaited<ReturnType<typeof reader.read>>
        try {
          next = await reader.read()
        } catch (e) {
          failed(e)
          reportCutOff()
          throw e
        }
        if (next.done) { reportCutOff(); controller.close(); return }
        if (forward(next.value, controller)) return
      }
    },
    async cancel(reason) {
      reportCutOff()
      await reader.cancel(reason)
    },
  })
}

/** Reasoning in a raw chat-completions chunk: `reasoning_content` (Cortecs, vLLM) or
 *  `reasoning` (OpenRouter). The SDK's chat model parses neither. */
function reasoningFromRaw(raw: unknown): string {
  const delta = (raw as { choices?: Array<{ delta?: { reasoning_content?: unknown; reasoning?: unknown } }> } | null)?.choices?.[0]?.delta
  const text = delta?.reasoning_content ?? delta?.reasoning
  return typeof text === 'string' ? text : ''
}

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')

const estimateTokens = (prompt: unknown) => Math.ceil(JSON.stringify(prompt ?? '').length / CHARS_PER_TOKEN)

/** The provider's own error text, short enough for a footer. */
function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/\s+/g, ' ').trim().slice(0, 200)
}
