/** A minimal OpenAI-compatible streaming server for tests.
 *
 *  Exists so the streaming pipeline can be exercised without a real model. Crucially it speaks
 *  the *wire* protocol rather than any AI SDK type, so the same tests hold across SDK major
 *  versions — the point being that a migration which silently renames stream-part fields
 *  (textDelta -> text, args/result -> input/output) still fails these tests, whereas a
 *  typecheck would not. */

export interface ScriptedStep {
  /** Text deltas emitted for this step, in order. */
  text?: string[]
  /** Reasoning deltas, for models that emit a separate reasoning channel. */
  reasoning?: string[]
  /** A tool call to emit instead of, or alongside, text. */
  toolCall?: { id: string; name: string; args: unknown }
}

/** Serves one scripted step per request, in order, so a multi-step tool loop can be driven. */
export function startFakeOpenAI(script: ScriptedStep[]) {
  let call = 0
  const requests: unknown[] = []

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 })
      }
      const body = await req.json().catch(() => null) as { stream?: boolean } | null
      requests.push(body)
      const step = script[Math.min(call, script.length - 1)]
      call++

      // generateText omits `stream` (or sends false) and expects a single JSON body rather than
      // an SSE stream; only streamText sets it true.
      if (body?.stream !== true) {
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'fake-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: (step.text ?? []).join(''),
              ...(step.toolCall
                ? {
                  tool_calls: [{
                    id: step.toolCall.id,
                    type: 'function',
                    function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.args) },
                  }],
                }
                : {}),
            },
            finish_reason: step.toolCall ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      }

      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`

      const parts: string[] = [chunk({ role: 'assistant', content: '' })]
      for (const r of step.reasoning ?? []) parts.push(chunk({ reasoning_content: r }))
      for (const t of step.text ?? []) parts.push(chunk({ content: t }))

      if (step.toolCall) {
        parts.push(chunk({
          tool_calls: [{
            index: 0,
            id: step.toolCall.id,
            type: 'function',
            function: { name: step.toolCall.name, arguments: '' },
          }],
        }))
        parts.push(chunk({
          tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.toolCall.args) } }],
        }))
        parts.push(chunk({}, 'tool_calls'))
      } else {
        parts.push(chunk({}, 'stop'))
      }
      parts.push('data: [DONE]\n\n')

      return new Response(parts.join(''), {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    },
  })

  return {
    baseURL: `http://localhost:${server.port}/v1`,
    get callCount() { return call },
    get requests() { return requests },
    stop: () => server.stop(true),
  }
}

/** Collects what the pipeline writes to the SSE stream, standing in for Hono's SSEStreamingApi. */
export function captureSSE() {
  const events: Array<Record<string, unknown>> = []
  return {
    stream: {
      writeSSE: async ({ data }: { data: string }) => { events.push(JSON.parse(data)) },
    },
    events,
    /** Concatenated deltas of one event type, e.g. text('text') -> the full answer. */
    concat(type: string): string {
      return events.filter(e => e.type === type).map(e => e.delta ?? '').join('')
    },
    ofType(type: string) { return events.filter(e => e.type === type) },
  }
}
