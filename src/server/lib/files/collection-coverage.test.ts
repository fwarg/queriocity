/** Whole-collection coverage: a small collection goes in full; a larger one is read document by
 *  document for the task (and an attached draft's card), by the answer model, cached per task, one at
 *  a time on a local model; the digest stands in when an extract fails. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fakeTarget, startFakeOpenAI, type ScriptedStep } from '../test-support/fake-openai.ts'
import type { ModelTarget } from '../llm.ts'

const { sqlite } = await import('../db.ts')
const { coverCollection, fitTexts } = await import('./collection-coverage.ts')
const { storedDigests } = await import('./collection-digests.ts')
const { joinParts } = await import('./collection-extracts.ts')

const USER = 'coverage-user'
const COLL = 'coverage-coll'

beforeAll(() => {
  sqlite.run('INSERT OR IGNORE INTO users(id, email, created_at, updated_at) VALUES (?,?,?,?)', [USER, `${USER}@coverage.test`, 0, 0])
  sqlite.run('INSERT OR IGNORE INTO spaces(id, name, user_id, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)', [COLL, 'Papers', USER, 'collection', 0, 0])
})

beforeEach(() => {
  sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
  sqlite.run('DELETE FROM resource_digests')
  sqlite.run('DELETE FROM resource_extracts')
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

/** Options that send a collection in full when it fits `budgetChars`, or read it for `task` (fullTextMaxChars 0). */
const opts = (model: ModelTarget, extra: Partial<Parameters<typeof coverCollection>[1]> = {}) =>
  ({ model, budgetChars: 10_000, fullTextMaxChars: 0, task: 'What do they say about bees?', ...extra })

/** What the fake model was asked, as text. */
const asked = (fake: ReturnType<typeof startFakeOpenAI>, from: number) => JSON.stringify(fake.requests.slice(from))

let fake: ReturnType<typeof startFakeOpenAI> | null = null
afterAll(() => fake?.stop())
function serve(script: ScriptedStep[]) {
  fake?.stop()
  fake = startFakeOpenAI(script)
  return fake
}

describe('coverCollection', () => {
  test('sends a collection under the threshold in full, labelled by filename order, without calling the model', async () => {
    const f = serve([{ text: ['x'] }])
    seedDoc('b.txt', 'Second paper.')
    const first = seedDoc('a.txt', 'First paper.')
    const c = await coverCollection([COLL], opts(fakeTarget(f.baseURL), { fullTextMaxChars: 10_000 }))
    expect(c.mode).toBe('full')
    expect(c.block).toContain('### [C1] a.txt\nFirst paper.')
    expect(c.block).toContain('### [C2] b.txt\nSecond paper.')
    expect(c.fileSources[0]).toEqual({ title: '[C1] a.txt', url: `file:${first}`, label: 'C1' })
    expect(f.callCount).toBe(0)
  })

  test('reads each document for the task, and reuses the extracts for the same task only', async () => {
    const f = serve([{ text: ['A paper on bees.\n- "Bees dance" (section 2)'] }])
    seedDoc('a.txt', 'Bees dance.')
    seedDoc('b.txt', 'Bees hum.')
    const progress: number[] = []
    const c = await coverCollection([COLL], opts(fakeTarget(f.baseURL), { onProgress: (done: number) => { progress.push(done) } }))
    expect(c.mode).toBe('extract')
    expect(c.block).toContain('### [C2] b.txt\nA paper on bees.')
    expect(asked(f, 0)).toContain('What do they say about bees?')
    expect(f.callCount).toBe(2)
    expect(progress).toEqual([0, 1, 2])
    await coverCollection([COLL], opts(fakeTarget(f.baseURL)))
    expect(f.callCount).toBe(2)
    await coverCollection([COLL], opts(fakeTarget(f.baseURL), { task: 'And about wasps?' }))
    expect(f.callCount).toBe(4)
  })

  test('reads each document with the attached draft\'s card in mind', async () => {
    const f = serve([{ text: ['DRAFT CARD: claims bees count'] }, { text: ['A paper.\n- relevant'] }])
    seedDoc('a.txt', 'Bees dance.')
    await coverCollection([COLL], opts(fakeTarget(f.baseURL), { draft: '[draft.md]\nMy draft about bees.' }))
    expect(JSON.stringify(f.requests[0])).toContain('My draft about bees.')
    expect(JSON.stringify(f.requests[1])).toContain('DRAFT CARD: claims bees count')
  })

  test('lists a document with nothing on the task, and counts it', async () => {
    const f = serve([{ text: ['A paper on wasps.\nNOTHING RELEVANT'] }])
    seedDoc('a.txt', 'Wasps sting.')
    const c = await coverCollection([COLL], opts(fakeTarget(f.baseURL)))
    expect(c.irrelevant).toBe(1)
    expect(c.block).toContain('A paper on wasps.\nNothing on this task.')
  })

  test('reads a document too long for one call in parts', async () => {
    const f = serve([{ text: ['A part.\n- point'] }])
    seedDoc('a.txt', 'w'.repeat(5000))
    // 1000 context tokens leaves the minimum of 2000 characters per call.
    await coverCollection([COLL], opts(fakeTarget(f.baseURL, 1000)))
    expect(f.callCount).toBe(3)
    expect(asked(f, 0)).toContain('part 3 of 3')
  })

  test('uses the digest when an extract fails, and lists it on the resource', async () => {
    const f = serve([{ error: { status: 400, message: 'refused' } }, { text: ['- Claims: bees dance.'] }])
    const id = seedDoc('a.txt', 'Bees dance.')
    const c = await coverCollection([COLL], opts(fakeTarget(f.baseURL)))
    expect(c.block).toContain('### [C1] a.txt\n- Claims: bees dance.')
    expect(await storedDigests(id)).toEqual([{ model: 'm', digest: '- Claims: bees dance.', createdAt: expect.any(Number) }])
  })

  test('falls back to the opening of a document whose extract and digest both fail', async () => {
    const f = serve([{ error: { status: 400, message: 'refused' } }])
    seedDoc('a.txt', 'Opening words. ' + 'z'.repeat(3000))
    const c = await coverCollection([COLL], opts(fakeTarget(f.baseURL)))
    expect(c.block).toContain('### [C1] a.txt\nOpening words.')
    expect(sqlite.prepare('SELECT count(*) AS n FROM resource_digests').get()).toEqual({ n: 0 })
  })

  test('leaves a confidential document out of an unlocked turn, and reads it in a locked one', async () => {
    const f = serve([{ text: ['x'] }])
    seedDoc('a.txt', 'Open paper.')
    const secret = seedDoc('b.txt', 'Secret paper.')
    sqlite.run('UPDATE uploaded_files SET confidential = 1 WHERE id = ?', [secret])
    const model = fakeTarget(f.baseURL)
    expect((await coverCollection([COLL], opts(model, { fullTextMaxChars: 10_000 }))).block).not.toContain('Secret paper.')
    expect((await coverCollection([COLL], opts(model, { fullTextMaxChars: 10_000, includeConfidential: true }))).block).toContain('Secret paper.')
  })
})

describe('joinParts', () => {
  test('keeps the parts that found something, and is irrelevant only when none did', () => {
    expect(joinParts(['A.\n- x', 'A.\nNOTHING RELEVANT'])).toEqual({ text: 'A.\n- x', relevant: true })
    expect(joinParts(['A.\nNOTHING RELEVANT', 'A.\nNOTHING RELEVANT'])).toEqual({ text: 'A.\nNothing on this task.', relevant: false })
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
    await coverCollection([COLL], opts(model))
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
