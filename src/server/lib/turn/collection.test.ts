/** A whole-collection turn: one answer call with every document in its prompt, no web search,
 *  the documents as file sources, and a coverage event for the footer. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fakeTarget, startFakeOpenAI, captureSSE } from '../test-support/fake-openai.ts'
import type { TurnContext } from './context.ts'

const { sqlite } = await import('../db.ts')
const { runTurn, createSink } = await import('./index.ts')

const USER = 'whole-coll-user'
const COLL = 'whole-coll'

let fake: ReturnType<typeof startFakeOpenAI>
beforeAll(() => {
  fake = startFakeOpenAI([{ text: ['Both papers study bees [C1][C2].'] }])
  sqlite.run('INSERT OR IGNORE INTO users(id, email, created_at, updated_at) VALUES (?,?,?,?)', [USER, `${USER}@whole.test`, 0, 0])
  sqlite.run('INSERT OR IGNORE INTO spaces(id, name, user_id, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)', [COLL, 'Papers', USER, 'collection', 0, 0])
  for (const [name, text] of [['a.txt', 'Paper A on bees.'], ['b.txt', 'Paper B on bees.']]) {
    const id = randomUUID()
    sqlite.run('INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)', [id, USER, name, 'text/plain', 0, 'file', 0])
    sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)', [`${id}:0`, id, text])
    sqlite.run('INSERT INTO space_files(space_id, file_id) VALUES (?,?)', [COLL, id])
  }
})
afterAll(() => fake.stop())

function ctxFor(): TurnContext {
  const model = fakeTarget(fake.baseURL)
  return {
    userId: USER, sid: 's', msgs: [{ role: 'user', content: 'Compare these papers.' }], pinned: new Set(),
    models: { chat: model, thinking: model, flash: model }, focusMode: 'balanced', locked: false,
    settings: {}, collections: [COLL], collectionMode: 'whole', abortSignal: new AbortController().signal,
  }
}

describe('whole-collection turn', () => {
  test('answers in one call from every document, without searching', async () => {
    const cap = captureSSE()
    const calls = fake.callCount
    const result = await runTurn(ctxFor(), createSink(cap.stream as never))
    expect(fake.callCount).toBe(calls + 1)
    const system = JSON.stringify(fake.requests.at(-1))
    expect(system).toContain('Paper A on bees.')
    expect(system).toContain('Paper B on bees.')
    expect(cap.ofType('coverage')).toEqual([{ type: 'coverage', documents: 2, mode: 'full', trimmed: false, irrelevant: 0 }])
    expect(cap.ofType('file_sources')[0].sources).toHaveLength(2)
    expect(cap.events.some(e => (e.step as { kind?: string } | undefined)?.kind === 'search')).toBe(false)
    expect(result).toMatchObject({ content: 'Both papers study bees [C1][C2].', cacheable: false })
    // Reading the documents is its own step; writing starts with the first output, after it.
    const steps = cap.events.flatMap(e => e.step ? [(e.step as { kind: string }).kind] : [])
    expect(steps).toEqual(['readFull', 'write'])
    expect(cap.events.findIndex(e => (e.step as { kind?: string } | undefined)?.kind === 'write'))
      .toBeLessThan(cap.events.findIndex(e => e.type === 'text'))
  })

  test('above the threshold, reads each document for the message, with the attached draft as a card', async () => {
    sqlite.run("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('collection_full_text_tokens', '0')")
    try {
      const from = fake.requests.length
      const ctx = { ...ctxFor(), msgs: [{ role: 'user' as const, content: 'Review my draft.\n\n---\n[draft.md]\nMY DRAFT TEXT' }] }
      await runTurn(ctx, createSink(captureSSE().stream as never))
      const asked = fake.requests.slice(from).map(r => JSON.stringify(r))
      // The draft card first, then one call per document, then the answer.
      expect(asked).toHaveLength(4)
      expect(asked[0]).toContain('MY DRAFT TEXT')
      expect(asked[1]).toContain('The task: Review my draft.')
      expect(asked[1]).not.toContain('MY DRAFT TEXT')
      expect(asked[3]).toContain('MY DRAFT TEXT')
    } finally {
      sqlite.run("DELETE FROM app_settings WHERE key = 'collection_full_text_tokens'")
    }
  })
})
