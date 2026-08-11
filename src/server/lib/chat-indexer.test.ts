import './test-support/test-env.ts'
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test'
import { sqlite } from './db.ts'

/** Indexing is content-addressed so that repeating it is free.
 *
 *  The case that forced this: a regenerate re-sends the user's message verbatim, and for a turn
 *  carrying a large attachment that meant re-embedding the whole document — measured at 4 → 9
 *  chunks and 5 embedding calls for a two-line exchange. It also left the rejected answer
 *  searchable, so chat RAG could surface text the user had thrown away. */

const DIM = 1024
let server: ReturnType<typeof Bun.serve>
let embedCalls: number[] = []

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.json() as { input: string | string[] }
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      embedCalls.push(inputs.length)
      return Response.json({ data: inputs.map((_, i) => ({ embedding: Array(DIM).fill(0.01), index: i })) })
    },
  })
  process.env.EMBED_BASE_URL = `http://localhost:${server.port}/v1`
  process.env.EMBED_MODEL = 'stub'
  process.env.EMBED_API_KEY = 'x'
})
afterAll(() => server.stop(true))

const SESSION = 's-index'
const chunkCount = () =>
  (sqlite.query('SELECT count(*) AS n FROM chat_chunk_meta').get() as { n: number }).n
const vectorCount = () =>
  (sqlite.query('SELECT count(*) AS n FROM chat_chunks').get() as { n: number }).n
const embedded = () => embedCalls.reduce((a, b) => a + b, 0)

// Long enough to produce several chunks at the 800-char chunk size.
const QUESTION = 'What does the attached specification say about termination clauses? '.repeat(30)
const FIRST_ANSWER = 'The first answer, later rejected. '.repeat(40)
const SECOND_ANSWER = 'The regenerated answer. '.repeat(40)

beforeEach(() => {
  sqlite.run('DELETE FROM chat_chunks')
  sqlite.run('DELETE FROM chat_chunk_meta')
  embedCalls = []
})

describe('indexContents', () => {
  it('indexes new content', async () => {
    const { indexContents } = await import('./chat-indexer.ts')
    const n = await indexContents(SESSION, [QUESTION, FIRST_ANSWER])
    expect(n).toBeGreaterThan(0)
    expect(chunkCount()).toBe(n)
    expect(vectorCount()).toBe(n)
    expect(embedded()).toBe(n)
  })

  it('is a no-op when the same content is indexed again — no rows, no embedding calls', async () => {
    const { indexContents } = await import('./chat-indexer.ts')
    const first = await indexContents(SESSION, [QUESTION, FIRST_ANSWER])
    const before = embedded()

    expect(await indexContents(SESSION, [QUESTION, FIRST_ANSWER])).toBe(0)
    expect(chunkCount()).toBe(first)
    // The saving that matters: the second pass never reached the embedding server.
    expect(embedded()).toBe(before)
  })

  it('embeds only the new answer when a turn is regenerated', async () => {
    const { indexContents } = await import('./chat-indexer.ts')
    await indexContents(SESSION, [QUESTION, FIRST_ANSWER])
    const afterFirst = chunkCount()
    const before = embedded()

    const added = await indexContents(SESSION, [QUESTION, SECOND_ANSWER])

    // The repeated question costs nothing; only the new answer is embedded.
    expect(embedded() - before).toBe(added)
    expect(chunkCount()).toBe(afterFirst + added)
  })

  it('still indexes a genuinely new question', async () => {
    const { indexContents } = await import('./chat-indexer.ts')
    await indexContents(SESSION, [QUESTION, FIRST_ANSWER])
    const before = chunkCount()
    await indexContents(SESSION, ['An entirely different follow-up question about pricing terms.', SECOND_ANSWER])
    expect(chunkCount()).toBeGreaterThan(before)
  })

  it('keeps sessions separate — the same text in two chats is two rows', async () => {
    const { indexContents } = await import('./chat-indexer.ts')
    await indexContents(SESSION, [QUESTION])
    const one = chunkCount()
    await indexContents('other-session', [QUESTION])
    expect(chunkCount()).toBe(one * 2)
  })
})

describe('deindexContent', () => {
  it('removes the rejected answer and leaves the question indexed', async () => {
    const { indexContents, deindexContent } = await import('./chat-indexer.ts')
    await indexContents(SESSION, [QUESTION, FIRST_ANSWER])
    const total = chunkCount()

    const removed = deindexContent(SESSION, FIRST_ANSWER)

    expect(removed).toBeGreaterThan(0)
    expect(chunkCount()).toBe(total - removed)
    expect(vectorCount()).toBe(total - removed)
    // The rejected text must not be retrievable any more.
    const left = (sqlite.query("SELECT count(*) AS n FROM chat_chunk_meta WHERE content LIKE '%later rejected%'").get() as { n: number }).n
    expect(left).toBe(0)
  })

  it('does not touch another session\'s identical text', async () => {
    const { indexContents, deindexContent } = await import('./chat-indexer.ts')
    await indexContents(SESSION, [FIRST_ANSWER])
    await indexContents('other-session', [FIRST_ANSWER])
    const total = chunkCount()

    const removed = deindexContent(SESSION, FIRST_ANSWER)

    expect(chunkCount()).toBe(total - removed)
    expect(chunkCount()).toBeGreaterThan(0)
  })
})
