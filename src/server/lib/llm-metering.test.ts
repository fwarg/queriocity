/** What a cloud provider reports beyond tokens — its own cost and the hosting provider it routed to —
 *  reaches the meter for each call, streamed or not, as Cortecs and OpenRouter send it. */

import { describe, test, expect, afterEach } from 'bun:test'
import { streamText, generateText } from 'ai'
import { startFakeOpenAI, fakeTarget, type ScriptedStep } from './test-support/fake-openai.ts'
import { languageModel, type TokenUsage } from './llm.ts'

let fake: ReturnType<typeof startFakeOpenAI> | null = null
afterEach(() => { fake?.stop(); fake = null })

/** A metered model on a fake serving `script`, and the usage each of its calls reported. */
function metered(script: ScriptedStep[]) {
  fake = startFakeOpenAI(script)
  const calls: TokenUsage[] = []
  return { model: languageModel({ ...fakeTarget(fake.baseURL), onUsage: u => { calls.push(u) } }), calls }
}

const CORTECS: ScriptedStep = {
  text: ['OK'],
  usage: { prompt_tokens: 14, completion_tokens: 73, cost: 25 },
  headers: { 'x-cortecs-provider': 'entrim' },
}

describe('per-call provider reports', () => {
  test("reads Cortecs' cost and hosting provider from a streamed reply", async () => {
    const { model, calls } = metered([CORTECS])
    await streamText({ model, prompt: 'Say OK' }).consumeStream()
    expect(calls).toEqual([{ inputTokens: 14, outputTokens: 73, reportedCost: 25, routedVia: 'entrim' }])
  })

  test('reads them from a non-streamed reply too', async () => {
    const { model, calls } = metered([CORTECS])
    await generateText({ model, prompt: 'Say OK' })
    expect(calls[0]).toMatchObject({ reportedCost: 25, routedVia: 'entrim' })
  })

  test('leaves the cost out when the provider reports none, rather than reusing an earlier one', async () => {
    const { model, calls } = metered([CORTECS, { text: ['Again'], usage: { prompt_tokens: 5, completion_tokens: 5 } }])
    await generateText({ model, prompt: 'one' })
    await generateText({ model, prompt: 'two' })
    expect(calls[1].reportedCost).toBeUndefined()
    // The routing header is per provider connection and does not change between steps.
    expect(calls[1].routedVia).toBe('entrim')
  })
})

describe('what the SDK alone would lose', () => {
  test('turns a provider\'s separate reasoning field into reasoning, ahead of the answer', async () => {
    const { model } = metered([{ reasoning: ['Thinking ', 'it over.'], text: ['OK'], usage: { prompt_tokens: 5, completion_tokens: 9 } }])
    const parts: Array<{ type: string; text?: string }> = []
    for await (const part of streamText({ model, prompt: 'Say OK' }).fullStream) parts.push(part as { type: string; text?: string })
    const reasoning = parts.filter(p => p.type === 'reasoning-delta').map(p => p.text).join('')
    expect(reasoning).toBe('Thinking it over.')
    expect(parts.findIndex(p => p.type === 'reasoning-delta')).toBeLessThan(parts.findIndex(p => p.type === 'text-delta'))
    expect(parts.some(p => p.type === 'raw')).toBe(false)
  })

  test('still reports a call that is stopped before the provider reports usage, as an estimate', async () => {
    const errors: string[] = []
    fake = startFakeOpenAI([{ text: ['late'], delayMs: 300 }])
    const calls: TokenUsage[] = []
    const model = languageModel({ ...fakeTarget(fake.baseURL), onUsage: u => { calls.push(u) }, onError: m => { errors.push(m) } })
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 50)
    await streamText({ model, prompt: 'A question long enough to count', abortSignal: stop.signal }).consumeStream({ onError: () => {} })
    expect(calls).toHaveLength(1)
    expect(calls[0].estimated).toBe(true)
    expect(calls[0].inputTokens).toBeGreaterThan(0)
    // A stop is the user's doing, not the provider failing.
    expect(errors).toEqual([])
  })

  test('passes on the provider\'s error message', async () => {
    fake = startFakeOpenAI([{ error: { status: 400, message: 'Model glm-x does not exist' } }])
    const errors: string[] = []
    const calls: TokenUsage[] = []
    const model = languageModel({ ...fakeTarget(fake.baseURL), onUsage: u => { calls.push(u) }, onError: m => { errors.push(m) } })
    await streamText({ model, prompt: 'Hi', maxRetries: 0 }).consumeStream({ onError: () => {} })
    expect(errors[0]).toContain('Model glm-x does not exist')
    // Refused outright, so not billed and not recorded.
    expect(calls).toEqual([])
  })

  test('passes on a default (unmetered) model\'s error too, such as a local server losing its GPU', async () => {
    fake = startFakeOpenAI([{ error: { status: 400, message: 'decode() failed: ErrorDeviceLost' } }])
    const errors: string[] = []
    const model = languageModel({ ...fakeTarget(fake.baseURL), onError: m => { errors.push(m) } })
    await streamText({ model, prompt: 'Hi', maxRetries: 0 }).consumeStream({ onError: () => {} })
    expect(errors[0]).toContain('ErrorDeviceLost')
  })
})

describe('long silent calls', () => {
  test('turn off Bun\'s response timeout, which a local model reading a long prompt outlasts', async () => {
    fake = startFakeOpenAI([{ text: ['OK'] }])
    const inits: Array<RequestInit & { timeout?: unknown }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => { inits.push(init ?? {}); return realFetch(input, init) }, { preconnect: realFetch.preconnect })
    try {
      await streamText({ model: languageModel(fakeTarget(fake.baseURL)), prompt: 'Hi' }).consumeStream()
    } finally {
      globalThis.fetch = realFetch
    }
    expect(inits[0]?.timeout).toBe(false)
  })
})

describe('an OpenRouter stream, as recorded', () => {
  // The chunks OpenRouter sent for deepseek/deepseek-v4.1-flash, trimmed to the fields that matter.
  const chunk = (delta: object, extra: object = {}) =>
    `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', created: 0, model: 'deepseek/deepseek-v4.1-flash', provider: 'Sail Research', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`
  const body = [
    chunk({ content: '', role: 'assistant', reasoning: 'We need' }),
    chunk({ content: '', role: 'assistant', reasoning: ' just OK.' }),
    chunk({ content: 'OK', role: 'assistant' }),
    chunk({ content: '', role: 'assistant', reasoning: null }),
    chunk({ content: '', role: 'assistant' }, { usage: { prompt_tokens: 32, completion_tokens: 21, total_tokens: 53, cost: 0.000006576 } }),
    'data: [DONE]\n\n',
  ].join('')

  test('keeps the reasoning in one block, and reads the cost and host', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
    try {
      const calls: TokenUsage[] = []
      const model = languageModel({ ...fakeTarget(`http://localhost:${server.port}/v1`), onUsage: u => { calls.push(u) } })
      const parts: Array<{ type: string; text?: string }> = []
      for await (const part of streamText({ model, prompt: 'Say OK' }).fullStream) parts.push(part as { type: string; text?: string })
      expect(parts.filter(p => p.type === 'reasoning-start')).toHaveLength(1)
      expect(parts.filter(p => p.type === 'reasoning-delta').map(p => p.text).join('')).toBe('We need just OK.')
      expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('OK')
      expect(calls).toEqual([{ inputTokens: 32, outputTokens: 21, reportedCost: 0.000006576, routedVia: 'Sail Research' }])
    } finally {
      server.stop(true)
    }
  })
})

describe('a call cut off mid-stream', () => {
  test('is reported as an estimate carrying the provider\'s generation id', async () => {
    const chunk = `data: ${JSON.stringify({ id: 'gen-9', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'Partial answer' }, finish_reason: null }] })}\n\n`
    // Sends one chunk, then holds the stream open as a slow model would.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chunk)) } }), {
        headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-9' },
      }),
    })
    try {
      const calls: TokenUsage[] = []
      const model = languageModel({ ...fakeTarget(`http://localhost:${server.port}/v1`), onUsage: u => { calls.push(u) } })
      const stop = new AbortController()
      setTimeout(() => stop.abort(), 150)
      await streamText({ model, prompt: 'Explain', abortSignal: stop.signal }).consumeStream({ onError: () => {} })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ estimated: true, generationId: 'gen-9' })
      expect(calls[0].outputTokens).toBeGreaterThan(0)
    } finally {
      server.stop(true)
    }
  })
})

describe('an unmetered model', () => {
  test('gets its separate reasoning field shown as reasoning too', async () => {
    fake = startFakeOpenAI([{ reasoning: ['Local thought.'], text: ['OK'] }])
    const parts: Array<{ type: string; text?: string }> = []
    for await (const part of streamText({ model: languageModel(fakeTarget(fake.baseURL)), prompt: 'Say OK' }).fullStream) parts.push(part as { type: string; text?: string })
    expect(parts.filter(p => p.type === 'reasoning-delta').map(p => p.text).join('')).toBe('Local thought.')
  })
})
