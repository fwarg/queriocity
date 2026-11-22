/** Feedback and trace storage: what survives a retry, a deletion and the retention sweep. */

import './test-support/test-env.ts'

import { describe, test, expect, beforeEach } from 'bun:test'
import type { TurnSink } from './turn/index.ts'

const { sqlite } = await import('./db.ts')
const { TraceRecorder, saveTrace, loadTrace, setFeedback, markRegenerated, feedbackFor, deleteFeedback, pruneTraces, TRACE_RETENTION_DAYS } = await import('./feedback.ts')

const USER = 'fb-user'
const SID = 'fb-session'
const DAY = 24 * 60 * 60

function seed() {
  sqlite.run('DELETE FROM users WHERE id = ?', [USER])
  sqlite.run("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, 'fb@test', 0, 0)", [USER])
  sqlite.run("INSERT INTO chat_sessions (id, title, user_id, created_at, updated_at) VALUES (?, 't', ?, 0, 0)", [SID, USER])
}

const trace = () => new TraceRecorder({ question: 'q', priorMessages: 0, focusMode: 'balanced' }).serialize('a')
const ageTrace = (id: string, days: number) =>
  sqlite.run('UPDATE research_traces SET created_at = ? WHERE message_id = ?', [Math.floor(Date.now() / 1000) - days * DAY, id])
const traceIds = () => (sqlite.query('SELECT message_id AS id FROM research_traces ORDER BY id').all() as Array<{ id: string }>).map(r => r.id)

beforeEach(seed)

describe('TraceRecorder', () => {
  test('records steps and kept events, passes everything through, and round-trips through storage', async () => {
    const seen: string[] = []
    const sink = {
      out: { writeSSE: async () => {}, ping: async () => {} },
      emit: async (e: { type: string }) => { seen.push(e.type) },
      step: async () => { seen.push('step') },
      context: async () => {},
      lastContext: undefined,
    } as unknown as TurnSink
    const rec = new TraceRecorder({ question: 'who?', priorMessages: 2, focusMode: 'thorough' })
    const wrapped = rec.wrap(sink)
    await wrapped.step({ kind: 'search', queries: ['x'] })
    await wrapped.emit({ type: 'sources', sources: [{ title: 'T', url: 'https://e.x', content: 'c'.repeat(1000) }] })
    await wrapped.emit({ type: 'text', delta: 'not kept' })
    expect(seen).toEqual(['step', 'sources', 'text'])

    saveTrace(SID, 'm1', rec.serialize('the answer'))
    const stored = loadTrace('m1') as { question: string; answer: string; entries: Array<Record<string, unknown>> }
    expect(stored.question).toBe('who?')
    expect(stored.answer).toBe('the answer')
    expect(stored.entries).toHaveLength(2)
    // Snippets are cut to the stored-source length, as in the messages table.
    expect(((stored.entries[1].sources as Array<{ content: string }>)[0].content).length).toBe(300)
  })
})

describe('feedback', () => {
  test('a retry marks only a traced answer, and the mark survives the answer row', () => {
    saveTrace(SID, 'traced', trace())
    markRegenerated(SID, 'traced')
    markRegenerated(SID, 'untraced')
    const rows = sqlite.query('SELECT message_id AS id FROM message_feedback WHERE regenerated = 1').all() as Array<{ id: string }>
    expect(rows.map(r => r.id)).toEqual(['traced'])
  })

  test('withdrawn feedback removes its row; reasons and comment round-trip', () => {
    setFeedback(SID, 'm', { rating: -1, reasons: ['wrong', 'outdated'], comment: ' old figures ' })
    expect(feedbackFor(SID).get('m')).toEqual({ rating: -1, reasons: ['wrong', 'outdated'], comment: 'old figures' })
    setFeedback(SID, 'm', { rating: null, reasons: [], comment: '' })
    expect(feedbackFor(SID).has('m')).toBe(false)
    expect(sqlite.query('SELECT 1 FROM message_feedback WHERE message_id = ?').get('m')).toBeNull()
  })

  test('deleting messages removes their feedback and traces; deleting the chat cascades', () => {
    saveTrace(SID, 'a', trace())
    setFeedback(SID, 'a', { rating: 1, reasons: [], comment: '' })
    saveTrace(SID, 'b', trace())
    deleteFeedback(['a'])
    expect(traceIds()).toEqual(['b'])
    expect(feedbackFor(SID).size).toBe(0)
    sqlite.run('DELETE FROM chat_sessions WHERE id = ?', [SID])
    expect(traceIds()).toEqual([])
  })
})

describe('pruneTraces', () => {
  test('drops old traces with no signal, keeps rated, retried and recent ones', () => {
    for (const id of ['old', 'rated', 'retried', 'recent']) saveTrace(SID, id, trace())
    for (const id of ['old', 'rated', 'retried']) ageTrace(id, TRACE_RETENTION_DAYS + 1)
    setFeedback(SID, 'rated', { rating: 1, reasons: [], comment: '' })
    markRegenerated(SID, 'retried')
    expect(pruneTraces()).toBe(1)
    expect(traceIds()).toEqual(['rated', 'recent', 'retried'])
  })
})
