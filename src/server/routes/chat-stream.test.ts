/** Characterization tests for the researcher -> SSE path.
 *
 *  These assert on queriocity's own SSE output, not on AI SDK types, so they survive an SDK
 *  major upgrade and act as a before/after oracle for one. They exist because the stream parts
 *  are read through hand-written structural casts (`part.text`, `part.input`, `part.output`),
 *  which a rename in a newer SDK would satisfy at compile time while yielding `undefined` at
 *  runtime — empty answers, missing sources, and a green typecheck. */

// Must precede the ./chat.ts import below — it reaches lib/auth.ts, which throws at load
// without JWT_SECRET. See the module for why.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, afterEach } from 'bun:test'
import { streamText, tool, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { startFakeOpenAI, captureSSE } from '../lib/test-support/fake-openai.ts'
import { drainResearcherStream } from '../lib/researcher-stream.ts'
import { recordingStream } from './chat.ts'
import { startRun } from '../lib/stream-buffer.ts'
import { ThinkExtractor } from '../lib/think-extractor.ts'
import type { SearchResult } from '../lib/searxng.ts'

let fake: ReturnType<typeof startFakeOpenAI> | null = null
afterEach(() => { fake?.stop(); fake = null })

const SOURCES: SearchResult[] = [
  { title: 'First result', url: 'https://example.com/a', content: 'alpha content' },
  { title: 'Second result', url: 'https://example.org/b', content: 'beta content' },
]

/** Mirrors how researcher.ts wires web_search: a tool whose result is an array of results. */
function makeRun(script: Parameters<typeof startFakeOpenAI>[0], maxSteps = 3) {
  fake = startFakeOpenAI(script)
  const model = createOpenAI({ baseURL: fake.baseURL, apiKey: 'test' }).chat('fake-model')
  return streamText({
    model,
    messages: [{ role: 'user', content: 'question' }],
    stopWhen: stepCountIs(maxSteps),
    tools: {
      web_search: tool({
        description: 'search',
        inputSchema: z.object({ queries: z.array(z.string()) }),
        execute: async () => SOURCES,
      }),
    },
  })
}

// Typed as the structural minimum drainResearcherStream needs, so the helper does not depend
// on the SDK's generic result type (which is reshaped across major versions).
function drain(result: { stream: AsyncIterable<unknown> }, cap: ReturnType<typeof captureSSE>, opts: Partial<{ showThinking: boolean; emitTextAsThinking: boolean; extractor: ThinkExtractor }> = {}) {
  const sources: SearchResult[] = []
  let text = ''
  return drainResearcherStream(result as never, {
    stream: cap.stream as never,
    showThinking: opts.showThinking ?? false,
    emitSearchStatus: () => {},
    extractor: opts.extractor ?? null,
    onText: async (t) => { text += t; await cap.stream.writeSSE({ data: JSON.stringify({ type: 'text', delta: t }) }) },
    onSources: (r) => { sources.push(...r) },
    emitTextAsThinking: opts.emitTextAsThinking ?? false,
  }).then(finishReason => ({ finishReason, sources, text }))
}

describe('drainResearcherStream', () => {
  test('streams text deltas through to the client', async () => {
    const cap = captureSSE()
    const { text, finishReason } = await drain(makeRun([{ text: ['Hello', ' ', 'world'] }]), cap)

    // The regression guard: a renamed delta field yields '' here while typecheck stays green.
    expect(text).toBe('Hello world')
    expect(cap.concat('text')).toBe('Hello world')
    expect(finishReason).toBe('stop')
  })

  test('surfaces web_search results as sources', async () => {
    const cap = captureSSE()
    const { sources, text } = await drain(makeRun([
      { toolCall: { id: 'call_1', name: 'web_search', args: { queries: ['q'] } } },
      { text: ['Answer with citation [1].'] },
    ]), cap)

    // Reads part.output (v4) / part.output (v5+) — the other silent-rename risk.
    expect(sources).toHaveLength(2)
    expect(sources[0].url).toBe('https://example.com/a')
    expect(text).toBe('Answer with citation [1].')
  })

  test('reports tool-calls when the model never writes prose', async () => {
    const cap = captureSSE()
    // Mirrors the failure the balanced step-gate exists to prevent: every step spent on tools.
    const { finishReason, text } = await drain(makeRun([
      { toolCall: { id: 'call_1', name: 'web_search', args: { queries: ['a'] } } },
    ], 1), cap)

    expect(text).toBe('')
    expect(finishReason).toBe('tool-calls')
  })

  // The extractor is what every caller now passes — the route's three branches and the monitor
  // executor. These cover the shared path rather than each caller's copy of it.
  test('with an extractor, <think> is routed to thinking and kept out of the answer', async () => {
    const cap = captureSSE()
    const { text } = await drain(
      makeRun([{ text: ['<think>weighing', ' options</think>', 'The answer.'] }]),
      cap,
      { extractor: new ThinkExtractor(), showThinking: true },
    )

    expect(text).toBe('The answer.')
    expect(cap.concat('thinking')).toBe('weighing options')
  })

  // The 2026-08-09 production failure: a withheld-tools final step wrote its call out as prose,
  // the extractor dropped all of it, and the turn ended with no answer at all. The drain is
  // correct to yield nothing here; the caller's job is to notice and run the fallback.
  test('with an extractor, leaked <tool_call> markup is dropped entirely', async () => {
    const cap = captureSSE()
    const { text, finishReason } = await drain(
      makeRun([{ text: ['<tool_call>{"name":', ' "web_search"}</tool_call>'] }]),
      cap,
      { extractor: new ThinkExtractor(), showThinking: true },
    )

    expect(text).toBe('')
    expect(cap.concat('text')).toBe('')
    // Dropped rather than shown as reasoning — it is a failed action, not thinking.
    expect(cap.concat('thinking')).toBe('')
    // Crucially not 'tool-calls': this is the case the old fallback condition missed.
    expect(finishReason).toBe('stop')
  })

  test('emits search queries and snippets on the thinking channel when enabled', async () => {
    const cap = captureSSE()
    await drain(makeRun([
      { toolCall: { id: 'call_1', name: 'web_search', args: { queries: ['climate'] } } },
      { text: ['Done.'] },
    ]), cap, { showThinking: true })

    const thinking = cap.concat('thinking')
    expect(thinking).toContain('First result')
    expect(thinking).toContain('https://example.com/a')
  })

  test('keeps thinking silent when the setting is off', async () => {
    const cap = captureSSE()
    await drain(makeRun([
      { toolCall: { id: 'call_1', name: 'web_search', args: { queries: ['x'] } } },
      { text: ['Done.'] },
    ]), cap, { showThinking: false })

    expect(cap.ofType('thinking')).toHaveLength(0)
  })
})

/** The resume cursor is a count of buffered events, so what does *not* get buffered matters as
 *  much as what does. Keepalives are connection-local on both the live and the resumed path; if
 *  one side records them and the other does not, `?from=` lands in the wrong place and the
 *  client silently loses that many events on reconnect. */
describe('keepalive pings and the resume buffer', () => {
  const fakeSSE = () => {
    const written: string[] = []
    return {
      written,
      api: { writeSSE: async ({ data }: { data: string }) => { written.push(data) } } as never,
    }
  }

  test('a ping reaches the client but is never recorded for replay', async () => {
    const run = startRun('sess-ping', 'u1')
    const sink = fakeSSE()
    const out = recordingStream(sink.api, run)

    await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: 'hi' }) })
    await out.ping()
    await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: ' there' }) })

    // Delivered live, so an idle connection stays warm...
    expect(sink.written.filter(d => d.includes('"ping"'))).toHaveLength(1)
    // ...but absent from the replay log, which holds only the two real events.
    expect(run.events).toHaveLength(2)
    expect(run.events.some(e => e.includes('"ping"'))).toBe(false)
  })

  test('a dead connection does not stop the run', async () => {
    const run = startRun('sess-dead', 'u1')
    const dead = { writeSSE: async () => { throw new Error('broken pipe') } } as never
    const out = recordingStream(dead, run)

    // Neither call may throw: the generation outlives the connection by design, and the
    // buffered events are what the client resumes from.
    await out.ping()
    await out.writeSSE({ data: JSON.stringify({ type: 'text', delta: 'kept' }) })

    expect(run.events).toEqual([JSON.stringify({ type: 'text', delta: 'kept' })])
  })
})
