/** The client addresses a running generation by session id — Stop, resume and egress approvals all
 *  take one. For a brand-new chat the client did not choose that id, so the server sends it as the
 *  first SSE event.
 *
 *  The bug this guards: `streamChat` consumed that event for its own resume bookkeeping and
 *  `continue`d, so it never reached the caller. The only remaining assignment was in the `done`
 *  handler, i.e. after the run had already finished — pressing Stop on a first message aborted the
 *  connection locally while the server kept generating for its full grace period and persisted the
 *  answer the user had cancelled. */

import { describe, test, expect, afterEach } from 'bun:test'
import { streamChat } from './api.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Serves a fixed SSE script once, then 404s any resume attempt so the generator ends promptly. */
function serveEvents(events: Array<Record<string, unknown>>) {
  let served = false
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (served) return new Response('gone', { status: 404 })
    served = true
    void url
    const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
}

const collect = async (gen: AsyncGenerator<{ type: string; [k: string]: unknown }>) => {
  const out: Array<{ type: string; [k: string]: unknown }> = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

describe('streamChat', () => {
  test('yields the session id, and yields it before the answer', async () => {
    serveEvents([
      { type: 'session', sessionId: 'sess-42' },
      { type: 'text', delta: 'hello' },
      { type: 'done', sessionId: 'sess-42', elapsedMs: 12 },
    ])

    const chunks = await collect(streamChat([{ role: 'user', content: 'hi' }], 'balanced'))

    const session = chunks.find(c => c.type === 'session')
    expect(session?.sessionId).toBe('sess-42')
    // Order is the whole point: an id that arrives with `done` cannot stop anything.
    expect(chunks.findIndex(c => c.type === 'session'))
      .toBeLessThan(chunks.findIndex(c => c.type === 'text'))
  })

  test('still passes every other event through untouched', async () => {
    serveEvents([
      { type: 'session', sessionId: 's1' },
      { type: 'status', text: 'searching' },
      { type: 'text', delta: 'a' },
      { type: 'done', sessionId: 's1' },
    ])

    const types = (await collect(streamChat([{ role: 'user', content: 'hi' }], 'flash'))).map(c => c.type)
    expect(types).toEqual(['session', 'status', 'text', 'done'])
  })

  test('drops pings, which are keepalives and would desync the resume cursor', async () => {
    serveEvents([
      { type: 'session', sessionId: 's2' },
      { type: 'ping' },
      { type: 'text', delta: 'a' },
      { type: 'done', sessionId: 's2' },
    ])

    const types = (await collect(streamChat([{ role: 'user', content: 'hi' }], 'flash'))).map(c => c.type)
    expect(types).not.toContain('ping')
  })
})
