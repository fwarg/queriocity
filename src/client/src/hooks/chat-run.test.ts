/** ChatRun folds a chat stream's events into the answer, its progress log and its footer — the
 *  logic that used to live inline in useChat's run(). Driven here with plain recorders for state. */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { translate } from '@shared/i18n/index.ts'
import type { TFunction } from '../lib/i18n.tsx'
import type { LogStep } from '../components/ProgressLog.tsx'
import { ChatRun, answerFooter, type ChatChunk, type EgressApproval, type FocusMode } from './chat-run.ts'

// No browser here: run animation frames immediately, and put the globals back for other files.
const original = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame }
beforeAll(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0 }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = () => {}
})
afterAll(() => {
  globalThis.requestAnimationFrame = original.raf
  globalThis.cancelAnimationFrame = original.caf
})

const t: TFunction = (key, vars) => translate('en', key, vars)

function harness(focusMode: FocusMode = 'balanced', question = 'What is a bee?') {
  const seen = { streaming: '', thinking: '', status: '', answerTime: '', steps: [] as LogStep[], approval: null as EgressApproval | null, sessions: [] as Array<[string, string]> }
  const liveSessionRef = { current: undefined as string | undefined }
  const run = new ChatRun({
    t,
    setStreaming: s => { seen.streaming = s },
    setStreamingThinking: s => { seen.thinking = s },
    setStatus: s => { seen.status = s },
    setSteps: s => { seen.steps = s },
    setAnswerTime: s => { seen.answerTime = s },
    setApproval: a => { seen.approval = typeof a === 'function' ? a(seen.approval) : a },
    setContext: () => {},
    rafRef: { current: 0 },
    liveSessionRef,
    onSessionCreated: (id, title) => { seen.sessions.push([id, title]) },
  }, question, focusMode)
  const feed = (...chunks: ChatChunk[]) => chunks.forEach(c => run.handle(c))
  return { run, seen, liveSessionRef, feed }
}

const step = (kind: string) => ({ type: 'status', text: kind, step: { kind } })
const done = (extra: Record<string, unknown> = {}) => ({ type: 'done', sessionId: 's1', elapsedMs: 2500, userMessageId: 'u1', assistantMessageId: 'a1', ...extra })

describe('ChatRun', () => {
  test('streams text, ends the open step when the answer starts, and clears the status line', () => {
    const { run, seen, feed } = harness()
    feed({ type: 'session', sessionId: 's1' }, step('search'), { type: 'status', text: 'Retrying…' }, { type: 'text', delta: 'Bees ' }, { type: 'text', delta: 'buzz.' })
    expect(seen.streaming).toBe('Bees buzz.')
    expect(seen.status).toBe('')
    expect(seen.steps).toHaveLength(1)
    expect(seen.steps[0].endedAt).toBeDefined()
    expect(run.text).toBe('Bees buzz.')
  })

  test('builds the stored answer with its sources, thinking and the model that wrote it', () => {
    const { run, liveSessionRef, seen, feed } = harness()
    feed(
      { type: 'session', sessionId: 's1' },
      { type: 'model', id: 'm', label: 'Big', kind: 'cloud', provider: 'Cloudy' },
      { type: 'sources', sources: [{ title: 'A', url: 'https://a.example' }] },
      { type: 'thinking', delta: 'hm' },
      { type: 'text', delta: 'Answer [1].' },
      done({ title: 'Bees' }),
    )
    expect(run.answer()).toMatchObject({
      id: 'a1', role: 'assistant', content: 'Answer [1].', thinking: 'hm',
      sources: [{ title: 'A', url: 'https://a.example' }], model: { id: 'm', kind: 'cloud', provider: 'Cloudy' },
    })
    expect(run.storedIds).toEqual({ user: 'u1', assistant: 'a1' })
    expect(liveSessionRef.current).toBe('s1')
    expect(seen.sessions).toEqual([['s1', 'Bees']])
    expect(seen.answerTime).toContain('this message was sent to Cloudy')
  })

  test('names the session after the question when the server sends no title', () => {
    const { seen, feed } = harness('flash', 'q'.repeat(80))
    feed({ type: 'text', delta: 'x' }, done())
    expect(seen.sessions[0][1]).toBe('q'.repeat(60))
  })

  test('counts an image as an answer, and nothing as none', () => {
    const image = harness('image')
    image.feed({ type: 'image', url: '/images/u/1.png', alt: 'a bee' })
    expect(image.run.produced).toBe(true)
    expect(image.run.answer()?.images).toEqual([{ url: '/images/u/1.png', alt: 'a bee' }])
    expect(harness().run.answer()).toBeNull()
  })

  test('raises, re-times and closes an egress prompt', () => {
    const { seen, feed } = harness()
    feed({ type: 'approval', id: 'p1', kind: 'fetch', target: 'https://x.example', reasons: ['r'], timeoutMs: 1000 })
    expect(seen.approval).toMatchObject({ id: 'p1', kind: 'fetch', target: 'https://x.example' })
    feed({ type: 'approval_closed', id: 'other' })
    expect(seen.approval?.id).toBe('p1')
    feed({ type: 'approval_closed', id: 'p1' })
    expect(seen.approval).toBeNull()
  })

  test('names the default model too, marked as the default', () => {
    const { run, seen, feed } = harness()
    feed({ type: 'text', delta: 'x' }, done({ model: { id: 'gemma4-26b', label: 'Gemma4-26B', kind: 'default' } }))
    expect(run.answer()?.model).toEqual({ id: 'gemma4-26b', label: 'Gemma4-26B', kind: 'default' })
    expect(seen.answerTime).toContain('Model: default (Gemma4-26B).')
  })

  test('takes the hosting provider and cost from the end of the run', () => {
    const { run, seen, feed } = harness()
    feed(
      { type: 'model', id: 'm', label: 'Big', kind: 'cloud', provider: 'Cortecs' },
      { type: 'text', delta: 'x' },
      done({ model: { id: 'm', label: 'Big', kind: 'cloud', provider: 'Cortecs', via: 'entrim', cost: 0.00002, currency: 'EUR' } }),
    )
    expect(run.answer()?.model).toMatchObject({ via: 'entrim', cost: 0.00002 })
    expect(seen.answerTime).toContain('passed it to entrim')
    expect(seen.answerTime).toContain('Cost: 0.000020 EUR.')
  })

  test('puts a cloud model\'s error in the footer, after the model note', () => {
    const { seen, feed } = harness()
    feed(
      { type: 'model', id: 'm', label: 'Big', kind: 'cloud', provider: 'Cortecs' },
      { type: 'model_error', provider: 'Cortecs', message: 'Model missing does not exist' },
      done(),
    )
    expect(seen.answerTime).toContain('Cortecs returned an error: Model missing does not exist')
    expect(seen.answerTime.indexOf('sent to Cortecs')).toBeLessThan(seen.answerTime.indexOf('returned an error'))
  })

  test('updates a document-reading step in place, and names the documents read in the footer', () => {
    const { seen, feed } = harness()
    const docs = (index: number) => ({ type: 'status', text: '', step: { kind: 'documents', index, total: 3, update: index > 0 } })
    feed(docs(0), docs(1), docs(2), { type: 'coverage', documents: 3, mode: 'extract', trimmed: true, irrelevant: 1 }, { type: 'text', delta: 'x' }, done())
    expect(seen.steps).toHaveLength(1)
    expect(seen.steps[0]).toMatchObject({ kind: 'documents', index: 2 })
    expect(seen.answerTime).toContain('3 documents read for this question, 1 with nothing on it, shortened to fit the model')
    expect(seen.answerTime).not.toContain(translate('en', 'answer.noSearchResults'))
  })

  test('says how Auto read the collection, and how an exploration went', () => {
    const { seen, feed } = harness()
    feed(
      { type: 'collection_mode', mode: 'explore', reason: 'a targeted question' },
      { type: 'exploration', steps: 12, notes: 5, endedEarly: true },
      { type: 'text', delta: 'x' }, done(),
    )
    expect(seen.answerTime).toContain('12 model calls exploring the collection, 5 notes, ended before the model was done')
    expect(seen.answerTime).toContain('Auto read the collection as Explore: a targeted question.')
  })

  test('puts a refused model pick in the footer', () => {
    const { seen, feed } = harness()
    feed({ type: 'model_notice', reason: 'budget' }, { type: 'text', delta: 'x' }, done())
    expect(seen.answerTime).toContain(translate('en', 'modelNotice.budget'))
  })
})

describe('answerFooter', () => {
  const base = { elapsedMs: 1234, images: 0, sources: 0, blockedEngines: [] as string[], modelNote: '' }

  test('says an always-searching mode found nothing, but not flash', () => {
    expect(answerFooter(t, { ...base, focusMode: 'balanced' })).toContain(translate('en', 'answer.noSearchResults'))
    expect(answerFooter(t, { ...base, focusMode: 'flash' })).not.toContain(translate('en', 'answer.noSearchResults'))
  })

  test('blames blocked engines for an empty search', () => {
    expect(answerFooter(t, { ...base, focusMode: 'balanced', blockedEngines: ['google'] })).toContain('google')
  })

  test('counts sources and appends the model note', () => {
    const footer = answerFooter(t, { ...base, focusMode: 'thorough', sources: 3, modelNote: 'Model: Big.' })
    expect(footer).toContain('3 search results')
    expect(footer.endsWith('. Model: Big.')).toBe(true)
  })
})
