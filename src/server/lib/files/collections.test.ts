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
const { readsConfidential, trackLeftOut } = await import('./confidential.ts')
const { confidentialInScope } = await import('./collection-coverage.ts')
const { searchUploads } = await import('./uploads-search.ts')

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
    [`${id}:0`, JSON.stringify(await embedText(content, 'document'))])
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

    const hits = await searchCollections(['c1', 'c2'], 'retrieval', await embedText('retrieval', 'query'), 10)
    expect(hits.map(h => h.filename).sort()).toEqual(['protocol.pdf', 'retrieval.pdf'])
  })

  test('returns the nearest excerpt first', async () => {
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('c2', 'Specs', 'collection')
    await seedResource('f1', 'retrieval.pdf', 'Dense retrieval outperforms sparse retrieval on this benchmark.', ['c1'])
    await seedResource('f2', 'protocol.pdf', 'The wire protocol frames every message with a length prefix.', ['c2'])

    const query = 'dense retrieval benchmark'
    const hits = await searchCollections(['c1', 'c2'], query, await embedText(query, 'query'), 10)
    expect(hits[0].filename).toBe('retrieval.pdf')
  })

  test('injects a resource filed in two collections only once', async () => {
    // Otherwise the excerpt spends the budget twice and reads to the model as two sources agreeing.
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('c2', 'Reading list', 'collection')
    await seedResource('f1', 'shared.pdf', 'A document that belongs to both collections at once.', ['c1', 'c2'])

    const hits = await searchCollections(['c1', 'c2'], 'document', await embedText('document', 'query'), 10)
    expect(hits).toHaveLength(1)
  })

  test('ignores resources that are in no selected collection', async () => {
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('s1', 'Thesis', 'space')
    await seedResource('f1', 'tagged.pdf', 'This document is filed in the selected collection.', ['c1'])
    await seedResource('f2', 'elsewhere.pdf', 'This document is filed in a space instead.', ['s1'])

    const hits = await searchCollections(['c1'], 'document', await embedText('document', 'query'), 10)
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
    expect(await searchCollections(['c1'], 'retrieval', await embedText('retrieval', 'query'), 2)).toHaveLength(2)
  })
})

describe('confidential resources', () => {
  // A resource is confidential by its own flag or by a confidential collection holding it. Retrieval
  // in an unlocked turn leaves both kinds out; a locked turn reads them.
  async function seedLibrary() {
    await seedGroup('c1', 'Papers', 'collection')
    await seedGroup('c2', 'Secret', 'collection')
    await seedResource('open', 'open.pdf', 'Retrieval and ranking, an open paper.', ['c1'])
    await seedResource('own', 'own.pdf', 'Retrieval and ranking, locked on its own.', ['c1'])
    await seedResource('viacoll', 'viacoll.pdf', 'Retrieval and ranking, locked by its collection.', ['c1', 'c2'])
    sqlite.run('UPDATE uploaded_files SET confidential = 1 WHERE id = ?', ['own'])
    sqlite.run('UPDATE spaces SET offline = 1 WHERE id = ?', ['c2'])
  }
  const ids = (rows: Array<{ fileId: string }>) => rows.map(r => r.fileId).sort()

  test('an unlocked turn leaves them out of collection and library search', async () => {
    await seedLibrary()
    const embedding = await embedText('retrieval', 'query')
    expect(ids(await searchCollections(['c1'], 'retrieval', embedding))).toEqual(['open'])
    expect(ids(await searchUploads('retrieval', OWNER))).toEqual(['open'])
  })

  test('a locked turn reads them', async () => {
    await seedLibrary()
    const embedding = await embedText('retrieval', 'query')
    expect(ids(await searchCollections(['c1'], 'retrieval', embedding, undefined, true))).toEqual(['open', 'own', 'viacoll'])
    expect(ids(await searchUploads('retrieval', OWNER, undefined, undefined, undefined, true))).toEqual(['open', 'own', 'viacoll'])
  })

  test('names what a turn reads that is confidential, and what an unlocked one leaves out', async () => {
    await seedLibrary()
    expect(readsConfidential({ collectionIds: ['c1'] })).toEqual([])
    expect(readsConfidential({ collectionIds: ['c2'] })).toEqual(['Secret'])
    expect(readsConfidential({ fileIds: ['open', 'own', 'viacoll'] }).sort()).toEqual(['own.pdf', 'viacoll.pdf'])
    expect(confidentialInScope(['c1']).sort()).toEqual(['own', 'viacoll'])
    // Pins narrow what is read, so they narrow what is left out.
    expect(confidentialInScope({ ids: ['c1'], pinned: { spaceId: 'c1', fileIds: ['open', 'own'] } })).toEqual(['own'])
  })

  test('records what an unlocked search left out, when a turn is tracking', async () => {
    await seedLibrary()
    const leftOut = new Set<string>()
    await trackLeftOut(leftOut, () => searchUploads('retrieval', OWNER))
    expect([...leftOut].sort()).toEqual(['own', 'viacoll'])
  })
})
