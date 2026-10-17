/** Explore mode, and what it stands on: documents as parts of their indexed excerpts, cached outlines,
 *  the Auto choice of mode, and the agent itself — driven by scripted tool calls from a fake model. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { fakeTarget, startFakeOpenAI, captureSSE, type ScriptedStep } from '../test-support/fake-openai.ts'
import { envOverride } from '../test-support/env-override.ts'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { startFakeSearxng } from '../test-support/fake-searxng.ts'
import type { TurnContext } from './context.ts'

const { sqlite, EMBED_DIMS } = await import('../db.ts')
const { joinChunks, documentParts, partOfChunk, outlineOf } = await import('../files/collection-parts.ts')
const { parseChoice, chooseMode } = await import('./collection-mode.ts')
const { compactReads } = await import('./collection-agent.ts')
const { searchSpread, readsBlock, firstLook } = await import('./collection-evidence.ts')
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
    const hits = searchSpread([a, b, c], vec(0), false).map((h: { doc: { label: string } }) => h.doc.label)
    expect(hits.slice(0, 3)).toEqual(['A', 'B', 'C'])
    expect(hits).toEqual(['A', 'B', 'C', 'A'])
  })
})

describe('readsBlock', () => {
  test('without a reranker, ranks parts by closeness to the question and stops at the budget', async () => {
    const vec = (off: number) => Array.from({ length: EMBED_DIMS }, (_, i) => i === 0 ? 1 : i === 1 ? off : 0)
    const id = seedDoc('ranked.txt', ['far one', 'x', 'y', 'close one'])
    // Every excerpt has a vector, as ingest gives them: sqlite-vec returns nothing for a filter that
    // names an id without one. Part 1 (excerpts 0–2) is far from the question, part 2 (excerpt 3) close.
    ;[2, 2, 2, 0].forEach((off, i) => sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [`${id}:${i}`, JSON.stringify(vec(off))]))
    const doc = { label: 'C9', fileId: id, filename: 'ranked.txt', summary: null }
    const reads = new Map([
      ['C9:1', { doc, part: 1, text: 'FAR PART '.repeat(20) }],
      ['C9:2', { doc, part: 2, text: 'CLOSE PART '.repeat(20) }],
    ])
    const { block } = await readsBlock({ notes: [], seen: new Map(), reads, queries: [], query: vec(0), locked: false }, 300)
    // Room for one part: the closer one goes in.
    expect(block).toContain('CLOSE PART')
    expect(block).not.toContain('FAR PART')
  })
})

describe('relevance floor', () => {
  /** A reranker scoring a passage 0.9 if it mentions "contract", else 0.01 — the range unrelated
   *  passages scored in a real run. */
  function fakeReranker() {
    return Bun.serve({
      port: 0,
      async fetch(req) {
        const { documents } = await req.json() as { documents: string[] }
        return Response.json({ results: documents.map((d, index) => ({ index, relevance_score: /contract/i.test(d) ? 0.9 : 0.01 })) })
      },
    })
  }

  test('the first look says a document has nothing close, and parts under the floor stay out of the answer', async () => {
    const reranker = fakeReranker()
    const embeddings = startFakeEmbeddings(EMBED_DIMS)
    const undo = envOverride({ RERANK_MODEL: 'fake', RERANK_BASE_URL: `http://localhost:${reranker.port}`, EMBED_BASE_URL: embeddings.baseURL, EMBED_API_KEY: 't', EMBED_MODEL: 'fake-embed' })
    try {
      const { embedText } = await import('../embeddings.ts')
      const docs = []
      for (const [name, text] of [['on.txt', 'Safety contracts with guarantees.'], ['off.txt', 'Risk norms for driving.']]) {
        const id = seedDoc(name, [text])
        sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [`${id}:0`, JSON.stringify(await embedText(text))])
        docs.push({ label: name === 'on.txt' ? 'C1' : 'C2', fileId: id, filename: name, summary: null })
      }
      const gathered = { notes: [], seen: new Map(), reads: new Map(), queries: [] as string[], locked: false }
      const look = await firstLook('Which papers discuss contracts?', docs, gathered)
      expect(look).toContain('[C1] part 1: Safety contracts with guarantees.')
      expect(look).toContain('[C2] nothing close to the message (best match scored 0.01)')
      gathered.reads.set('C1:1', { doc: docs[0], part: 1, text: 'Safety contracts with guarantees.' })
      gathered.reads.set('C2:1', { doc: docs[1], part: 1, text: 'Risk norms for driving.' })
      const { block } = await readsBlock(gathered, 10_000)
      expect(block).toContain('Safety contracts with guarantees.')
      expect(block).not.toContain('Risk norms for driving.')
    } finally {
      undo()
      reranker.stop(true)
      embeddings.stop()
    }
  })

  test('when nothing clears the floor, the first look rules nothing out and every part read is passed on', async () => {
    const reranker = fakeReranker()
    const embeddings = startFakeEmbeddings(EMBED_DIMS)
    const undo = envOverride({ RERANK_MODEL: 'fake', RERANK_BASE_URL: `http://localhost:${reranker.port}`, EMBED_BASE_URL: embeddings.baseURL, EMBED_API_KEY: 't', EMBED_MODEL: 'fake-embed' })
    try {
      const { embedText } = await import('../embeddings.ts')
      const id = seedDoc('off.txt', ['Risk norms for driving.'])
      sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [`${id}:0`, JSON.stringify(await embedText('Risk norms for driving.'))])
      const doc = { label: 'C1', fileId: id, filename: 'off.txt', summary: null }
      const gathered = { notes: [], seen: new Map(), reads: new Map(), queries: [] as string[], locked: false }
      const look = await firstLook('Can you check again?', [doc], gathered)
      expect(look).toContain('This rules no document out')
      expect(look).not.toContain('nothing close')
      gathered.reads.set('C1:1', { doc, part: 1, text: 'Risk norms for driving.' })
      const { block } = await readsBlock(gathered, 10_000)
      expect(block).toContain('Risk norms for driving.')
    } finally {
      undo()
      reranker.stop(true)
      embeddings.stop()
    }
  })

  test('a part read is judged against the model\'s searches too, not only the message', async () => {
    const reranker = fakeReranker()
    const undo = envOverride({ RERANK_MODEL: 'fake', RERANK_BASE_URL: `http://localhost:${reranker.port}` })
    try {
      const doc = { label: 'C1', fileId: 'f', filename: 'a.txt', summary: null }
      const reads = new Map([
        ['C1:1', { doc, part: 1, text: 'Safety contracts with guarantees.' }],
        ['C1:2', { doc, part: 2, text: 'Risk norms for driving.' }],
      ])
      // The message scores nothing ("check again"); the fake reranker scores by the passage, so make it
      // score by the query instead: only a query naming contracts lifts the contract part.
      reranker.reload({
        async fetch(req) {
          const { query, documents } = await req.json() as { query: string; documents: string[] }
          return Response.json({ results: documents.map((d, index) => ({ index, relevance_score: /contract/i.test(query) && /contract/i.test(d) ? 0.9 : 0.01 })) })
        },
      })
      const gathered = { notes: [], seen: new Map(), reads, queries: ['contract'], task: 'Can you check again?', floor: 0.05, locked: false }
      const { block } = await readsBlock(gathered, 10_000)
      expect(block).toContain('Safety contracts with guarantees.')
      expect(block).not.toContain('Risk norms for driving.')
    } finally {
      undo()
      reranker.stop(true)
    }
  })
})

describe('floor on searches', () => {
  test('shows the model every hit it asked for, but passes only those above the floor to the answer', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    const reranker = Bun.serve({ port: 0, async fetch(req) {
      const { documents } = await req.json() as { documents: string[] }
      return Response.json({ results: documents.map((d, index) => ({ index, relevance_score: /contract/i.test(d) ? 0.9 : 0.01 })) })
    } })
    const embeddings = startFakeEmbeddings(EMBED_DIMS)
    const undo = envOverride({ RERANK_MODEL: 'fake', RERANK_BASE_URL: `http://localhost:${reranker.port}`, EMBED_BASE_URL: embeddings.baseURL, EMBED_API_KEY: 't', EMBED_MODEL: 'fake-embed' })
    try {
      const { embedText } = await import('../embeddings.ts')
      for (const [name, text] of [['on.txt', 'Safety contracts with guarantees.'], ['off.txt', 'Risk norms for driving.']]) {
        const id = seedDoc(name, [text])
        sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [`${id}:0`, JSON.stringify(await embedText(text))])
      }
      const model = fakeTarget('')
      const f = serve([{ toolCall: { id: 's1', name: 'search_collection', args: { query: 'driving' } } }, { text: ['done'] }, { text: ['Answer.'] }])
      const ctx: TurnContext = {
        userId: USER, sid: 's', msgs: [{ role: 'user', content: 'Which papers discuss contracts?' }], pinned: new Set(),
        models: { chat: { ...model, baseURL: f.baseURL }, thinking: { ...model, baseURL: f.baseURL }, flash: { ...model, baseURL: f.baseURL } },
        focusMode: 'balanced', locked: false, settings: {}, collections: [COLL], collectionMode: 'explore', abortSignal: new AbortController().signal,
      }
      await runTurn(ctx, createSink(captureSSE().stream as never))
      // The tool result the model got (in the next request) shows the below-floor passage…
      expect(JSON.stringify(f.requests[1])).toContain('Risk norms for driving.')
      // …but the answer is not handed it unasked.
      expect(JSON.stringify(f.requests.at(-1))).not.toContain('Risk norms for driving.')
    } finally {
      undo()
      reranker.stop(true)
      embeddings.stop()
    }
  })
})

describe('explore turn', () => {
  // Every explore turn embeds the message for its first look, so the embeddings are served throughout.
  let embeddings: ReturnType<typeof startFakeEmbeddings>
  let undoEmbed: () => void
  beforeAll(() => {
    embeddings = startFakeEmbeddings(EMBED_DIMS)
    undoEmbed = envOverride({ EMBED_BASE_URL: embeddings.baseURL, EMBED_API_KEY: 't', EMBED_MODEL: 'fake-embed' })
  })
  afterAll(() => { undoEmbed(); embeddings.stop() })
  const ctxFor = (model: ReturnType<typeof fakeTarget>): TurnContext => ({
    userId: USER, sid: 's', msgs: [{ role: 'user', content: 'Which paper uses GSN?' }], pinned: new Set(),
    models: { chat: model, thinking: model, flash: model }, focusMode: 'balanced', locked: false,
    settings: {}, collections: [COLL], collectionMode: 'explore', abortSignal: new AbortController().signal,
  })
  const call = (name: string, args: unknown, id = name): ScriptedStep => ({ toolCall: { id, name, args } })

  test('with the web opted in, may search it, and the answer gets the results numbered as sources', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    seedDoc('gsn.txt', ['This paper argues with GSN patterns.'])
    const searxng = startFakeSearxng()
    const undo = envOverride({ SEARXNG_URL: searxng.url, SPEJAREN_URL: '', SEARCH_API_PROVIDER: '' })
    try {
      const f = serve([call('web_search', { query: 'Meyer design by contract' }), { text: ['done'] }, { text: ['Meyer coined it [1]; [C1] uses GSN.'] }])
      const cap = captureSSE()
      const result = await runTurn({ ...ctxFor(fakeTarget(f.baseURL)), exploreWeb: true }, createSink(cap.stream as never))
      expect(JSON.stringify(f.requests[0])).toContain('web_search')
      expect(searxng.queries).toContain('Meyer design by contract')
      const answer = JSON.stringify(f.requests.at(-1))
      expect(answer).toContain('## Web results')
      expect(answer).toContain('[1] Result 1')
      expect(cap.ofType('sources')[0].sources).toHaveLength(3)
      expect(result.sources).toHaveLength(3)
    } finally {
      undo()
      searxng.stop()
    }
  })

  test('offers no web search unless opted in, nor in a locked turn', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    seedDoc('gsn.txt', ['This paper argues with GSN patterns.'])
    for (const extra of [{}, { exploreWeb: true, locked: true }]) {
      const f = serve([{ text: ['done'] }, { text: ['Answer.'] }])
      await runTurn({ ...ctxFor(fakeTarget(f.baseURL)), ...extra }, createSink(captureSSE().stream as never))
      expect(JSON.stringify(f.requests[0])).not.toContain('web_search')
    }
  })

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

  test('looks at every document first, and answers from what searches showed even without notes', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    {
      const { embedText } = await import('../embeddings.ts')
      for (const [name, text] of [['a.txt', 'Contracts with assumptions and guarantees.'], ['b.txt', 'Risk norms for driving.']]) {
        const id = seedDoc(name, [text])
        sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)', [`${id}:0`, JSON.stringify(await embedText(text))])
      }
      const f = serve([call('search_collection', { query: 'contracts' }), { text: ['done'] }, { text: ['[C1] has contracts.'] }])
      await runTurn(ctxFor(fakeTarget(f.baseURL)), createSink(captureSSE().stream as never))
      // The first look is in the very first prompt, one passage per document.
      const first = JSON.stringify(f.requests[0])
      expect(first).toContain('A first look')
      expect(first).toContain('Risk norms for driving.')
      // Nothing was noted, yet the passages the agent saw reach the answer.
      const answer = JSON.stringify(f.requests.at(-1))
      expect(answer).toContain('(nothing was noted)')
      expect(answer).toContain('[C1 part 1] Contracts with assumptions and guarantees.')
    }
  })

  test('asks for a note after each read, and passes every part read on in full, noted or not', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    seedDoc('a.txt', ['Noted part about GSN.'])
    seedDoc('b.txt', ['Unnoted part about contracts.'])
    const f = serve([
      call('read_part', { doc: 'C1', part: 1 }, 'r1'),
      call('note', { doc: 'C1', part: 1, finding: 'Uses GSN' }, 'n1'),
      call('read_part', { doc: 'C2', part: 1 }, 'r2'),
      call('note', { doc: 'C2', finding: 'Something on contracts' }, 'n2'),
      { text: ['done'] },
      { text: ['Answer.'] },
    ])
    await runTurn(ctxFor(fakeTarget(f.baseURL)), createSink(captureSSE().stream as never))
    // The step after each read offers only `note`; the others offer every tool.
    const offered = (i: number) => ((f.requests[i] as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map(t => t.function.name)
    expect(offered(1)).toEqual(['note'])
    expect(offered(3)).toEqual(['note'])
    expect(offered(2).length).toBeGreaterThan(1)
    const answer = JSON.stringify(f.requests.at(-1))
    expect(answer).toContain('### [C2 part 1]')
    expect(answer).toContain('Unnoted part about contracts.')
    // Noted too: a note may be a sentence where the part holds a page.
    expect(answer).toContain('### [C1 part 1]')
  })

  test('takes a part number sent as text, and a model that answers instead of noting just ends the exploration', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    seedDoc('a.txt', ['The only part.'])
    const f = serve([
      call('read_part', { doc: 'C1', part: '1' }),
      // Asked for a note, it answers instead: no failure, and the part read still reaches the answer.
      { text: ['I have what I need.'] },
      { text: ['Answer.'] },
    ])
    const cap = captureSSE()
    const result = await runTurn(ctxFor(fakeTarget(f.baseURL)), createSink(cap.stream as never))
    expect(result.content).toBe('Answer.')
    expect(cap.ofType('exploration')).toEqual([{ type: 'exploration', steps: 2, notes: 0, endedEarly: false }])
    expect(JSON.stringify(f.requests.at(-1))).toContain('The only part.')
  })

  test('turns away a repeated read, and tells the answer where material was found', async () => {
    sqlite.run('DELETE FROM space_files WHERE space_id = ?', [COLL])
    seedDoc('a.txt', ['Part about GSN.'])
    const f = serve([
      call('read_part', { doc: 'C1', part: 1 }, 'r1'),
      call('note', { doc: 'C1', part: 1, finding: 'GSN' }, 'n1'),
      call('read_part', { doc: 'C1', part: 1 }, 'r2'),
      { text: ['done'] },
      { text: ['Answer.'] },
    ])
    await runTurn(ctxFor(fakeTarget(f.baseURL)), createSink(captureSSE().stream as never))
    // The repeat is answered from memory, and does not count as a new read asking for a note.
    expect(JSON.stringify(f.requests[3])).toContain('Already read C1 part 1')
    const offered = ((f.requests[3] as { tools?: unknown[] }).tools ?? []).length
    expect(offered).toBeGreaterThan(1)
    const answer = JSON.stringify(f.requests.at(-1))
    expect(answer).toContain('Where relevant material was found')
    expect(answer).toContain('- C1: part 1')
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
