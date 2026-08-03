/** Characterization tests for the researcher -> SSE path.
 *
 *  These assert on queriocity's own SSE output, not on AI SDK types, so they survive an SDK
 *  major upgrade and act as a before/after oracle for one. They exist because the stream parts
 *  are read through hand-written structural casts (`part.text`, `part.input`, `part.output`),
 *  which a rename in a newer SDK would satisfy at compile time while yielding `undefined` at
 *  runtime — empty answers, missing sources, and a green typecheck. */

import { describe, test, expect, afterEach } from 'bun:test'
import { streamText, tool, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { startFakeOpenAI, captureSSE } from '../lib/test-support/fake-openai.ts'
import { drainResearcherStream } from './chat.ts'
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
function drain(result: { stream: AsyncIterable<unknown> }, cap: ReturnType<typeof captureSSE>, opts: Partial<{ showThinking: boolean; emitTextAsThinking: boolean }> = {}) {
  const sources: SearchResult[] = []
  let text = ''
  return drainResearcherStream(result as never, {
    stream: cap.stream as never,
    showThinking: opts.showThinking ?? false,
    emitSearchStatus: () => {},
    extractor: null,
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
