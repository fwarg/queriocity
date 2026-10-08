/** "Similar content" with a reranker: it judges the cosine candidates, its floor decides what is
 *  shown, and cosine similarity takes over when the reranker fails. Separate from
 *  related-graph.test.ts because the reranker is configured from env at module load. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { envOverride } from '../test-support/env-override.ts'

/** Scores each document by whether it mentions "orchard": a logit, as llama.cpp returns. */
let failing = false
const reranker = Bun.serve({
  port: 0,
  async fetch(req) {
    if (failing) return new Response('down', { status: 503 })
    const { documents } = await req.json() as { documents: string[] }
    return Response.json({ results: documents.map((d, index) => ({ index, relevance_score: d.includes('orchard') ? 3 : -4 })) })
  },
})
const restoreRerank = envOverride({ RERANK_MODEL: 'fake-rerank', RERANK_BASE_URL: `http://localhost:${reranker.port}` })

const { db, sqlite, users, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { saveNote } = await import('./notes.ts')
const { relatedResources } = await import('./related.ts')

const ME = 'rr-user'
let embeddings: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  embeddings = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: embeddings.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  await db.insert(users).values({ id: ME, email: `${ME}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
})

afterAll(() => { embeddings?.stop(); reranker.stop(true); restoreEnv?.(); restoreRerank() })
beforeEach(() => { failing = false; sqlite.run('DELETE FROM uploaded_files WHERE user_id = ?', [ME]) })

const THRESHOLDS = { minSimilarity: 0.5, minRelevance: 0.5 }

describe('relatedResources with a reranker', () => {
  test('shows what the reranker finds relevant, even below the cosine threshold, and drops the rest', async () => {
    const target = await saveNote(ME, { title: 'Bees', body: 'Honey bees pollinate apple trees in spring.' })
    const judgedRelevant = await saveNote(ME, { title: 'Orchard care', body: 'Pruning an orchard in winter keeps it healthy.' })
    const wordTwin = await saveNote(ME, { title: 'Bees again', body: 'Honey bees pollinate apple trees in spring.' })

    const ids = (await relatedResources(ME, target, THRESHOLDS)).related.map(r => r.id)
    expect(ids).toEqual([judgedRelevant])
    expect(ids).not.toContain(wordTwin)
  })

  test('falls back to cosine similarity when the reranker fails', async () => {
    const target = await saveNote(ME, { title: 'Bees', body: 'Honey bees pollinate apple trees in spring.' })
    const twin = await saveNote(ME, { title: 'Bees again', body: 'Honey bees pollinate apple trees in spring.' })
    await saveNote(ME, { title: 'Orchard care', body: 'Pruning an orchard in winter keeps it healthy.' })
    failing = true

    expect((await relatedResources(ME, target, THRESHOLDS)).related.map(r => r.id)).toEqual([twin])
  })
})
