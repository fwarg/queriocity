/** Explore mode, and what it stands on: documents as parts of their indexed excerpts, cached outlines,
 *  the Auto choice of mode, and the agent itself — driven by scripted tool calls from a fake model. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { fakeTarget, startFakeOpenAI, captureSSE, type ScriptedStep } from '../test-support/fake-openai.ts'
import { envOverride } from '../test-support/env-override.ts'
import type { TurnContext } from './context.ts'

const { sqlite, EMBED_DIMS } = await import('../db.ts')
const { joinChunks, documentParts, partOfChunk, outlineOf } = await import('../files/collection-parts.ts')
const { parseChoice, chooseMode } = await import('./collection-mode.ts')
const { compactReads, searchSpread } = await import('./collection-agent.ts')
const { runTurn, createSink } = await import('./index.ts')

const USER = 'explore-user'
const COLL = 'explore-coll'
let fake: ReturnType<typeof startFakeOpenAI> | null = null
let restoreEnv: (() => void) | null = null
afterEach(() => { fake?.stop(); fake = null; restoreEnv?.(); restoreEnv = null })

/** A fake model for every role, the small one included. */
function serve(script: ScriptedStep[]) {
  fake = startFakeOpenAI(script)
  restoreEnv = envOverride({ SMALL_BASE_URL: fake.baseURL, SMALL_MODEL: 'small', SMALL_API_KEY: 't' })
  return fake
}

beforeAll(() => {
  sqlite.run('INSERT OR IGNORE INTO users(id, email, created_at, updated_at) VALUES (?,?,?,?)', [USER, `${USER}@explore.test`, 0, 0])
  sqlite.run('INSERT OR IGNORE INTO spaces(id, name, user_id, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)', [COLL, 'Papers', USER, 'collection', 0, 0])
})
afterAll(() => sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL]))

/** A resource of these chunks, filed in the test collection. */
function seedDoc(filename: string, chunks: string[]): string {
  const id = randomUUID()
  sqlite.run('INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)', [id, USER, filename, 'text/plain', 0, 'file', 0])
  chunks.forEach((c, i) => sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)', [`${id}:${i}`, id, c]))
  sqlite.run('INSERT INTO space_files(space_id, file_id) VALUES (?,?)', [COLL, id])
  return id
}

describe('parts', () => {
  test('join consecutive excerpts, dropping the repeat where they overlap', () => {
    const shared = 'the overlapping sentence that both excerpts carry. '
    expect(joinChunks(['First part ends with ' + shared, shared + 'and the second goes on.']))
      .toBe('First part ends with ' + shared + 'and the second goes on.')
    // No repeat long enough to trust: kept apart, nothing dropped.
    expect(joinChunks(['One.', 'Two.'])).toBe('One.\nTwo.')
  })

  test('group three excerpts each, numbered from 1, and a chunk maps to its part', () => {
    const id = seedDoc('parts.txt', ['a', 'b', 'c', 'd'])
    expect(documentParts(id).map(p => p.index)).toEqual([1, 2])
    expect([partOfChunk(0), partOfChunk(2), partOfChunk(3)]).toEqual([1, 1, 2])
  })

  test('outline each part once, then from the cache', async () => {
    const f = serve([{ text: ['Introduction and the problem.'] }])
    const id = seedDoc('outlined.txt', ['Intro.', 'Problem.', 'More.'])
    const parts = documentParts(id)
    expect(await outlineOf(id, parts)).toEqual(['Introduction and the problem.'])
    await outlineOf(id, parts)
    expect(f.callCount).toBe(1)
  })
})

describe('auto choice', () => {
  test('reads the mode and reason from the reply, and defaults to excerpts', () => {
    expect(parseChoice('explore - a targeted question')).toEqual({ mode: 'explore', reason: 'a targeted question' })
    expect(parseChoice('Whole: compare all')).toEqual({ mode: 'whole', reason: 'compare all' })
    expect(parseChoice('no idea').mode).toBe('excerpts')
  })

  test('falls back to excerpts when the small model fails', async () => {
    serve([{ error: { status: 400, message: 'down' } }])
    expect((await chooseMode('Which papers use GSN?', 1)).mode).toBe('excerpts')
  })
})

describe('compactReads', () => {
  test('keeps the latest two parts read and replaces the older ones', () => {
    const read = (id: string): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'read_part', output: { type: 'text', value: `text ${id}` } }] })
    const out = JSON.stringify(compactReads([read('a'), read('b'), read('c')]))
    expect(out).not.toContain('text a')
    expect(out).toContain('text b')
    expect(out).toContain('text c')
  })
})

describe('searchSpread', () => {
  /** A unit vector along `axis`, nudged towards the next axis by `off` — the larger, the farther from axis 0. */
  const vec = (off: number) => Array.from({ length: EMBED_DIMS }, (_, i) => i === 0 ? 1 : i === 1 ? off : 0)
  function seedVectors(filename: string, offsets: number[]) {
    const id = seedDoc(filename, offsets.map((_, i) => `${filename} excerpt ${i}`))
    offsets.forEach((off, i) => sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [`${id}:${i}`, JSON.stringify(vec(off))]))
    return { label: filename, fileId: id, filename, summary: null }
  }

  test('gives each document its best match before any document gets a second', () => {
    // A has four close matches; B one, a little farther; C one, far off.
    const a = seedVectors('A', [0, 0.01, 0.02, 0.03])
    const b = seedVectors('B', [0.1])
    const c = seedVectors('C', [2])
    const hits = searchSpread([a, b, c], vec(0), false).map(h => h.doc.label)
    expect(hits.slice(0, 3)).toEqual(['A', 'B', 'C'])
    expect(hits).toEqual(['A', 'B', 'C', 'A'])
  })
})

describe('explore turn', () => {
  const ctxFor = (model: ReturnType<typeof fakeTarget>): TurnContext => ({
    userId: USER, sid: 's', msgs: [{ role: 'user', content: 'Which paper uses GSN?' }], pinned: new Set(),
    models: { chat: model, thinking: model, flash: model }, focusMode: 'balanced', locked: false,
    settings: {}, collections: [COLL], collectionMode: 'explore', abortSignal: new AbortController().signal,
  })
  const call = (name: string, args: unknown, id = name): ScriptedStep => ({ toolCall: { id, name, args } })

  test('lists, reads and notes, then answers from its notes', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    seedDoc('gsn.txt', ['This paper argues with GSN patterns.'])
    const f = serve([
      call('list_documents', {}),
      call('read_part', { doc: 'C1', part: 1 }),
      call('note', { doc: 'C1', part: 1, finding: 'Uses GSN', quote: 'argues with GSN patterns' }),
      { text: ['done'] },
      { text: ['[C1] uses GSN.'] },
    ])
    const cap = captureSSE()
    const result = await runTurn(ctxFor(fakeTarget(f.baseURL)), createSink(cap.stream as never))
    expect(result.content).toBe('[C1] uses GSN.')
    expect(JSON.stringify(f.requests.at(-1))).toContain('[C1 part 1] Uses GSN')
    expect(cap.ofType('exploration')).toEqual([{ type: 'exploration', steps: 4, notes: 1, endedEarly: false }])
    const steps = cap.events.flatMap(e => e.step ? [(e.step as { kind: string }).kind] : [])
    expect(steps).toEqual(['readPart', 'note', 'readNotes', 'write'])
  })

  test('at the step limit, answers from what was noted and says it ended early', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    seedDoc('gsn.txt', ['GSN.'])
    sqlite.run("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('collection_explore_max_steps', '3')")
    try {
      const f = serve([
        call('note', { doc: 'C1', finding: 'Mentions GSN' }, 'n1'),
        call('list_documents', {}, 'l1'),
        call('list_documents', {}, 'l2'),
        { text: ['Partial answer [C1].'] },
      ])
      const cap = captureSSE()
      const result = await runTurn(ctxFor(fakeTarget(f.baseURL)), createSink(cap.stream as never))
      expect(cap.ofType('exploration')).toEqual([{ type: 'exploration', steps: 3, notes: 1, endedEarly: true }])
      expect(result.content).toBe('Partial answer [C1].')
    } finally {
      sqlite.run("DELETE FROM app_settings WHERE key = 'collection_explore_max_steps'")
    }
  })
})
