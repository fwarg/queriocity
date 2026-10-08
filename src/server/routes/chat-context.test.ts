/** Pinned messages and the context report, end to end: a pin survives trimming in a real chat
 *  request, the client is told where the model's view begins, and pins persist per message. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { startFakeOpenAI } from '../lib/test-support/fake-openai.ts'
import { envOverride } from '../lib/test-support/env-override.ts'
import type { ContextReport } from '../../shared/context.ts'

const { db, users, chatSessions, messages } = await import('../lib/db.ts')
const { eq } = await import('drizzle-orm')
const { chatRouter } = await import('./chat.ts')
const { historyRouter } = await import('./history.ts')
const { signToken, AUTH_COOKIE } = await import('../lib/auth.ts')

const USER = 'ctx-user'
const OTHER = 'ctx-other'
const app = new Hono().route('/chat', chatRouter).route('/history', historyRouter)
const cookies: Record<string, string> = {}
let fake: ReturnType<typeof startFakeOpenAI>
let restoreEnv: () => void

beforeAll(async () => {
  const now = new Date()
  for (const id of [USER, OTHER]) {
    await db.insert(users).values({ id, email: `${id}@example.com`, name: null, role: 'user', settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now })
    cookies[id] = `${AUTH_COOKIE}=${await signToken({ userId: id, email: `${id}@example.com`, role: 'user', tokenVersion: 0 })}`
  }
  fake = startFakeOpenAI(Array.from({ length: 5 }, () => ({ text: ['Answer.'] })))
  restoreEnv = envOverride({ CHAT_BASE_URL: fake.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'fake', CONTEXT_TOKEN_LIMIT: '1000' })
})

afterAll(() => { fake?.stop(); restoreEnv?.() })

/** Server-sent events of one chat request, parsed. */
async function chat(body: unknown): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const res = await app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookies[USER] },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
}

const filler = (label: string) => `${label} ${'x'.repeat(800)}`

describe('chat request with a long history', () => {
  test('keeps the pinned first message and reports the cut after it', async () => {
    const history = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: filler(`m${i}`) }))
    const events = await chat({
      focusMode: 'flash',
      ephemeral: true,
      messages: [{ ...history[0], pinned: true }, ...history.slice(1)],
    })
    const report = events.find(e => e.type === 'context') as unknown as ContextReport
    expect(report).toBeDefined()
    expect(report.cut).toBeGreaterThan(1)
    expect(report.lostBefore).toBe(report.cut)
    expect(report.pinnedChars).toBeGreaterThan(0)
    // The model got the pinned message and none of what was cut after it.
    const sent = JSON.stringify(fake.requests.at(-1))
    expect(sent).toContain('m0 ')
    expect(sent).not.toContain('m1 ')
    expect(sent).not.toContain('"pinned"')
  })
})

describe('stored context report', () => {
  test('is saved with the chat and returned when it is reopened', async () => {
    const events = await chat({ focusMode: 'flash', sessionId: 'ctx-stored', messages: [{ role: 'user', content: filler('q') }] })
    const live = events.find(e => e.type === 'context')
    const detail = await (await app.request('/history/ctx-stored', { headers: { Cookie: cookies[USER] } })).json()
    expect({ type: 'context', ...JSON.parse(detail.session.contextReport) }).toEqual(live!)
  })
})

describe('PATCH /history/:id/messages/:mid', () => {
  test('pins and unpins a message of the user\'s own chat, and refuses anyone else', async () => {
    const now = new Date()
    await db.insert(chatSessions).values({ id: 'ctx-chat', title: 'c', userId: USER, createdAt: now, updatedAt: now })
    await db.insert(messages).values({ id: 'ctx-msg', sessionId: 'ctx-chat', role: 'user', content: 'q', createdAt: now })
    const patch = (who: string, pinned: boolean, mid = 'ctx-msg') => app.request(`/history/ctx-chat/messages/${mid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify({ pinned }),
    })
    const pinnedNow = async () => (await db.select().from(messages).where(eq(messages.id, 'ctx-msg')).get())?.pinned

    expect((await patch(USER, true)).status).toBe(200)
    expect(await pinnedNow()).toBe(true)
    const detail = await (await app.request('/history/ctx-chat', { headers: { Cookie: cookies[USER] } })).json()
    expect(detail.messages[0].pinned).toBe(true)

    expect((await patch(OTHER, false)).status).toBe(404)
    expect(await pinnedNow()).toBe(true)
    expect((await patch(USER, false, 'no-such-message')).status).toBe(404)

    expect((await patch(USER, false)).status).toBe(200)
    expect(await pinnedNow()).toBe(false)
  })
})
