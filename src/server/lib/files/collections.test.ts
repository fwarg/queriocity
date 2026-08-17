/** Collections are a second *kind* of space, which is what lets `searchSpaceFiles` serve them
 *  unchanged. These cover the two things that reuse does not give for free: merging several
 *  collections into one ranking, and not injecting the same excerpt twice when a resource is filed
 *  in two of them. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, sqlite, users, spaces, EMBED_DIMS } = await import('../db.ts')
const { embedText } = await import('../embeddings.ts')
const { ownedCollectionIds, searchCollections } = await import('./collections.ts')

const OWNER = 'coll-owner'
const STRANGER = 'coll-stranger'

let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })

  const now = new Date()
  // Emails are unique across the whole suite: bun runs every test file in one process against
  // one in-memory database, so a plain `other@example.com` collides with another file's seed.
  for (const id of [OWNER, STRANGER]) {
    await db.insert(users).values({
      id, email: `${id}@collections.test`, name: null, role: 'user',
      settings: '{}', createdAt: now, updatedAt: now,
    })
  }
})

afterAll(() => {
  server?.stop()
  restoreEnv?.()
})

beforeEach(() => {
  sqlite.run('DELETE FROM file_chunks')
  sqlite.run('DELETE FROM file_chunk_meta')
  sqlite.run('DELETE FROM space_files')
  sqlite.run('DELETE FROM uploaded_files')
  sqlite.run('DELETE FROM spaces')
})

async function seedGroup(id: string, name: string, kind: 'space' | 'collection', userId = OWNER) {
  const now = new Date()
  await db.insert(spaces).values({ id, name, userId, kind, createdAt: now, updatedAt: now })
}

/** A resource with one chunk, embedded through the same path ingest uses, tagged to `groupIds`. */
async function seedResource(id: string, filename: string, content: string, groupIds: string[]) {
  sqlite.run(
    'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, OWNER, filename, 'text/plain', content.length, 'file', 0],
  )
  sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)', [`${id}:0`, id, content])
  sqlite.run('INSERT INTO file_chunks(chunk_id, embedding) VALUES (?,?)',
    [`${id}:0`, JSON.stringify(await embedText(content))])
  for (const groupId of groupIds) {
    sqlite.run('INSERT INTO space_files(space_id, file_id) VALUES (?,?)', [groupId, id])
  }
}

describe('ownedCollectionIds', () => {
  test('keeps only collections this user owns', async () => {
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('s1', 'Thesis', 'space')
    await seedGroup('c2', 'Theirs', 'collection', STRANGER)

    // A space is not a collection, and someone else's collection is not this user's — both drop out
    // silently rather than erroring, so a stale id from an open tab cannot fail the turn.
    expect(await ownedCollectionIds(['c1', 's1', 'c2', 'nonexistent'], OWNER)).toEqual(['c1'])
  })

  test('preserves the order it was given', async () => {
    await seedGroup('c1', 'A', 'collection')
    await seedGroup('c2', 'B', 'collection')
    expect(await ownedCollectionIds(['c2', 'c1'], OWNER)).toEqual(['c2', 'c1'])
  })

  test('returns nothing for an empty selection, without a query', async () => {
    expect(await ownedCollectionIds([], OWNER)).toEqual([])
  })
})

describe('searchCollections', () => {
  test('finds resources across several collections at once', async () => {
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('c2', 'Specs', 'collection')
    await seedResource('f1', 'retrieval.pdf', 'Dense retrieval outperforms sparse retrieval on this benchmark.', ['c1'])
    await seedResource('f2', 'protocol.pdf', 'The wire protocol frames every message with a length prefix.', ['c2'])

    const hits = await searchCollections(['c1', 'c2'], 'retrieval', await embedText('retrieval'), 10)
    expect(hits.map(h => h.filename).sort()).toEqual(['protocol.pdf', 'retrieval.pdf'])
  })

  test('returns the nearest excerpt first', async () => {
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('c2', 'Specs', 'collection')
    await seedResource('f1', 'retrieval.pdf', 'Dense retrieval outperforms sparse retrieval on this benchmark.', ['c1'])
    await seedResource('f2', 'protocol.pdf', 'The wire protocol frames every message with a length prefix.', ['c2'])

    const query = 'dense retrieval benchmark'
    const hits = await searchCollections(['c1', 'c2'], query, await embedText(query), 10)
    expect(hits[0].filename).toBe('retrieval.pdf')
  })

  test('injects a resource filed in two collections only once', async () => {
    // Otherwise the excerpt spends the budget twice and reads to the model as two sources agreeing.
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('c2', 'Reading list', 'collection')
    await seedResource('f1', 'shared.pdf', 'A document that belongs to both collections at once.', ['c1', 'c2'])

    const hits = await searchCollections(['c1', 'c2'], 'document', await embedText('document'), 10)
    expect(hits).toHaveLength(1)
  })

  test('ignores resources that are in no selected collection', async () => {
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('s1', 'Thesis', 'space')
    await seedResource('f1', 'tagged.pdf', 'This document is filed in the selected collection.', ['c1'])
    await seedResource('f2', 'elsewhere.pdf', 'This document is filed in a space instead.', ['s1'])

    const hits = await searchCollections(['c1'], 'document', await embedText('document'), 10)
    expect(hits.map(h => h.filename)).toEqual(['tagged.pdf'])
  })

  test('returns nothing for an empty selection, without touching the database', async () => {
    const before = server.requests.length
    expect(await searchCollections([], 'anything', [], 10)).toEqual([])
    expect(server.requests.length).toBe(before)
  })

  test('respects the result limit across the merged set', async () => {
    await seedGroup('c1', 'Papers', 'collection')
    for (let i = 0; i < 5; i++) {
      await seedResource(`f${i}`, `doc${i}.pdf`, `Document number ${i} about retrieval and ranking.`, ['c1'])
    }
    expect(await searchCollections(['c1'], 'retrieval', await embedText('retrieval'), 2)).toHaveLength(2)
  })
})
