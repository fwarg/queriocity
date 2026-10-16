/** Whole-collection coverage: the documents go in full when they fit, else as one digest each, made
 *  by the answer model, cached, and one at a time on a local model. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fakeTarget, startFakeOpenAI } from '../test-support/fake-openai.ts'
import type { ModelTarget } from '../llm.ts'

const { sqlite } = await import('../db.ts')
const { coverCollection, fitTexts, storedDigests } = await import('./collection-coverage.ts')

const USER = 'coverage-user'
const COLL = 'coverage-coll'

beforeAll(() => {
  sqlite.run('INSERT OR IGNORE INTO users(id, email, created_at, updated_at) VALUES (?,?,?,?)', [USER, `${USER}@coverage.test`, 0, 0])
  sqlite.run('INSERT OR IGNORE INTO spaces(id, name, user_id, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)', [COLL, 'Papers', USER, 'collection', 0, 0])
})

beforeEach(() => {
  sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
  sqlite.run('DELETE FROM resource_digests')
})

/** A resource of one chunk, filed in the test collection. */
function seedDoc(filename: string, content: string): string {
  const id = randomUUID()
  sqlite.run('INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, USER, filename, 'text/plain', 0, 'file', 0])
  sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)', [`${id}:0`, id, content])
  sqlite.run('INSERT INTO space_files(space_id, file_id) VALUES (?,?)', [COLL, id])
  return id
}

describe('coverCollection', () => {
  let fake: ReturnType<typeof startFakeOpenAI>
  beforeAll(() => { fake = startFakeOpenAI([{ text: ['- Claims: bees dance.'] }]) })
  afterAll(() => fake.stop())

  test('sends every document in full when they fit, labelled by filename order, without calling the model', async () => {
    seedDoc('b.txt', 'Second paper.')
    const first = seedDoc('a.txt', 'First paper.')
    const calls = fake.callCount
    const c = await coverCollection([COLL], { model: fakeTarget(fake.baseURL), budgetChars: 10_000 })
    expect(c.mode).toBe('full')
    expect(c.block).toContain('### [C1] a.txt\nFirst paper.')
    expect(c.block).toContain('### [C2] b.txt\nSecond paper.')
    expect(c.fileSources[0]).toEqual({ title: '[C1] a.txt', url: `file:${first}`, label: 'C1' })
    expect(fake.callCount).toBe(calls)
  })

  test('digests documents that do not fit, and reuses the digests on the next turn', async () => {
    seedDoc('a.txt', 'x'.repeat(3000))
    seedDoc('b.txt', 'y'.repeat(3000))
    const calls = fake.callCount
    const progress: number[] = []
    const opts = { model: fakeTarget(fake.baseURL), budgetChars: 2000, onProgress: (done: number) => { progress.push(done) } }
    const c = await coverCollection([COLL], opts)
    expect(c.mode).toBe('digest')
    expect(c.block).toContain('### [C2] b.txt\n- Claims: bees dance.')
    expect(fake.callCount).toBe(calls + 2)
    expect(progress).toEqual([0, 1, 2])
    await coverCollection([COLL], opts)
    expect(fake.callCount).toBe(calls + 2)
  })

  test('leaves a confidential document out of an unlocked turn, and reads it in a locked one', async () => {
    seedDoc('a.txt', 'Open paper.')
    const secret = seedDoc('b.txt', 'Secret paper.')
    sqlite.run('UPDATE uploaded_files SET confidential = 1 WHERE id = ?', [secret])
    const model = fakeTarget(fake.baseURL)
    expect((await coverCollection([COLL], { model, budgetChars: 10_000 })).block).not.toContain('Secret paper.')
    expect((await coverCollection([COLL], { model, budgetChars: 10_000, includeConfidential: true })).block).toContain('Secret paper.')
  })

  test('lists a resource\'s stored digests with the model that made them', async () => {
    const id = seedDoc('a.txt', 'x'.repeat(3000))
    await coverCollection([COLL], { model: fakeTarget(fake.baseURL), budgetChars: 500 })
    expect(await storedDigests(id)).toEqual([{ model: 'm', digest: '- Claims: bees dance.', createdAt: expect.any(Number) }])
  })

  test('falls back to the opening of a document whose digest fails, and does not cache it', async () => {
    const failing = startFakeOpenAI([{ error: { status: 400, message: 'refused' } }])
    try {
      seedDoc('a.txt', 'Opening words. ' + 'z'.repeat(3000))
      const c = await coverCollection([COLL], { model: fakeTarget(failing.baseURL), budgetChars: 2500 })
      expect(c.block).toContain('### [C1] a.txt\nOpening words.')
      expect(sqlite.prepare('SELECT count(*) AS n FROM resource_digests').get()).toEqual({ n: 0 })
    } finally {
      failing.stop()
    }
  })
})

describe('map concurrency', () => {
  let inFlight = 0
  let peak = 0
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch() {
        peak = Math.max(peak, ++inFlight)
        await Bun.sleep(30)
        inFlight--
        return Response.json({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'digest' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      },
    })
  })
  afterAll(() => server.stop(true))
  const baseURL = () => `http://localhost:${server.port}/v1`

  async function peakFor(model: ModelTarget) {
    for (const name of ['a', 'b', 'c', 'd']) seedDoc(`${name}.txt`, name.repeat(3000))
    peak = 0
    await coverCollection([COLL], { model, budgetChars: 1000 })
    return peak
  }

  test('one call at a time on a local model', async () => {
    expect(await peakFor(fakeTarget(baseURL()))).toBe(1)
  })

  test('up to three at once on a cloud (metered) model', async () => {
    expect(await peakFor({ ...fakeTarget(baseURL()), onUsage: () => {} })).toBe(3)
  })
})

describe('fitTexts', () => {
  test('leaves texts that fit alone', () => {
    expect(fitTexts(['ab', 'cd'], 4)).toEqual({ texts: ['ab', 'cd'], trimmed: false })
  })

  test('keeps short texts whole and shares the rest equally', () => {
    const { texts, trimmed } = fitTexts(['ab', 'x'.repeat(100), 'y'.repeat(100)], 22)
    expect(trimmed).toBe(true)
    expect(texts[0]).toBe('ab')
    expect(texts[1]).toHaveLength(10)
    expect(texts[2]).toHaveLength(10)
  })
})
