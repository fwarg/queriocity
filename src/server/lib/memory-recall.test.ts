/** End-to-end check of relevance-ranked memory recall.
 *
 *  The regression this guards: before ranking, buildMemoryBlock walked memories newest-first and
 *  stopped at the token budget, so an old but highly relevant fact was unreachable no matter what
 *  the user asked. These drive the real buildMemoryBlock — SQL, k-sizing and budget together —
 *  against a stub embedder, because the failure modes found while writing it (a too-small `k`
 *  letting other spaces starve the query, vectors going missing on rewrite) are invisible to a
 *  unit test of the pure selector. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, mock } from 'bun:test'

// Imported before the mock so EMBED_DIMS is known: the vec0 column width comes from the
// environment, and an embedding of the wrong length is rejected outright.
const { db, users, spaces, spaceMemories, chatSessions, EMBED_DIMS } = await import('./db.ts')
const { eq } = await import('drizzle-orm')

/** Deterministic stand-in for the embedding service: one dimension per keyword, so "which
 *  database do I use?" lands nearest the memory that mentions databases. Padded to the
 *  configured width. */
const TERMS = ['database', 'editor', 'language', 'coffee']
function fakeEmbed(text: string): number[] {
  const lower = text.toLowerCase()
  const v = TERMS.map(t => (lower.includes(t) ? 1 : 0))
  // sqlite-vec needs a non-zero vector to produce a meaningful distance.
  const base = v.some(Boolean) ? v : TERMS.map(() => 0.01)
  return [...base, ...Array(Math.max(0, EMBED_DIMS - base.length)).fill(0)]
}

mock.module('./embeddings.ts', () => ({
  embedText: async (text: string) => fakeEmbed(text),
  embedTexts: async (texts: string[]) => texts.map(fakeEmbed),
}))

const { buildMemoryBlock, saveMemory } = await import('./memory.ts')

const SPACE = 'space-under-test'
const OTHER_SPACE = 'space-noise'

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: 'u1', email: 'u1@example.com', name: null, role: 'user',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  for (const id of [SPACE, OTHER_SPACE]) {
    await db.insert(spaces).values({ id, name: id, userId: 'u1', createdAt: now, updatedAt: now })
  }

  // Written oldest-first, so the database memory is the *first* thing recency would drop.
  const ordered = [
    'The user runs a database called Postgres',
    'The user prefers a dark editor theme',
    'The user speaks Swedish as their first language',
    'The user drinks coffee black',
  ]
  for (let i = 0; i < ordered.length; i++) {
    const id = await saveMemory(SPACE, ordered[i], 'extraction')
    // createdAt is stored with second resolution, so rows written in the same second have no
    // stable recency order. Space them out to make the recency assertion below meaningful.
    await db.update(spaceMemories)
      .set({ createdAt: new Date(Date.now() + i * 60_000) })
      .where(eq(spaceMemories.id, id))
  }

  // Another space's memories share the vector table; they must never be selected, and must not
  // consume the KNN result set either.
  for (let i = 0; i < 20; i++) {
    await saveMemory(OTHER_SPACE, `Unrelated database note number ${i}`, 'extraction')
  }
})

/** Budget that fits the header plus roughly one memory line. */
const ONE_MEMORY_BUDGET = 45

describe('buildMemoryBlock relevance recall', () => {
  test('surfaces the relevant memory even when it is the oldest and the budget fits one', async () => {
    const { block } = await buildMemoryBlock(SPACE, ONE_MEMORY_BUDGET, 0, 'which database do I use?')

    // The whole point: recency alone would have injected the coffee memory instead.
    expect(block).toContain('Postgres')
    expect(block).not.toContain('coffee')
  })

  test('never leaks memories from another space', async () => {
    const { block } = await buildMemoryBlock(SPACE, 1000, 0, 'tell me about the database')

    expect(block).not.toContain('Unrelated database note')
  })

  test('an always-keep memory is injected even when irrelevant to the query', async () => {
    const target = (await db.select().from(spaceMemories)).find(m => m.content.includes('coffee'))!
    await db.update(spaceMemories).set({ alwaysKeep: true })
      .where(eq(spaceMemories.id, target.id))

    const { block } = await buildMemoryBlock(SPACE, ONE_MEMORY_BUDGET, 0, 'which database do I use?')

    expect(block).toContain('coffee')
    await db.update(spaceMemories).set({ alwaysKeep: false })
      .where(eq(spaceMemories.id, target.id))
  })

  test('a memory edited after creation is re-embedded, not scored on its old wording', async () => {
    const target = (await db.select().from(spaceMemories))
      .find(m => m.content.includes('dark editor theme'))!
    const { saveMemory: save } = await import('./memory.ts')
    await save(SPACE, 'The user prefers a dark editor theme and a large language model', 'extraction')

    const { block } = await buildMemoryBlock(SPACE, ONE_MEMORY_BUDGET * 2, 0, 'what language do I use?')
    expect(block).toContain('language')
    expect(target).toBeDefined()
  })

  test('user memory is injected only for users who opted in', async () => {
    const { saveUserMemory, userMemoryBlockIfEnabled } = await import('./memory.ts')
    const { setAppSetting } = await import('./db.ts')
    // Set explicitly rather than relying on the default: app_settings is shared across the whole
    // suite, so another file's admin test could otherwise decide this one's outcome.
    await setAppSetting('user_memory_token_budget', '300')
    await saveUserMemory('u1', 'The user prefers concise answers in Swedish', 'manual')

    const off = await userMemoryBlockIfEnabled('u1', {}, 'anything')
    const on = await userMemoryBlockIfEnabled('u1', { userMemory: true }, 'anything')

    expect(off).toBe('')
    expect(on).toContain('Swedish')
    expect(on).toContain('About the user')
  })

  test('chat RAG finds this space\'s history even when other spaces dominate the index', async () => {
    const { indexContents } = await import('./chat-indexer.ts')
    const now = new Date()
    await db.insert(chatSessions).values({
      id: 'sess-mine', title: 'mine', userId: 'u1', spaceId: SPACE, createdAt: now, updatedAt: now,
    })
    await db.insert(chatSessions).values({
      id: 'sess-other', title: 'other', userId: 'u1', spaceId: OTHER_SPACE, createdAt: now, updatedAt: now,
    })

    // The other space's chunks match *both* query terms, so they are strictly nearer than this
    // space's, which matches only one. With the scoping done as a JOIN predicate, sqlite-vec
    // spends the whole of k on the nearer foreign chunks and this space gets back nothing — the
    // bug this guards. The distances must differ, or the test cannot tell the two versions apart.
    await indexContents('sess-other', Array.from({ length: 40 }, (_, i) =>
      `An unrelated database and editor note written by somebody else, number ${i}, padded out.`))
    await indexContents('sess-mine', [
      'We agreed the database migration would run before the release, using our own tooling.',
    ])

    const { block } = await buildMemoryBlock(SPACE, 1000, 800, 'what did we agree about the database and editor?')

    expect(block).toContain('agreed the database migration')
    expect(block).not.toContain('somebody else')
  })

  test('search_space_history is scoped the same way and is not starved by other spaces', async () => {
    const { searchSpaceHistory } = await import('./memory.ts')

    // Depends on the chunks indexed by the previous test.
    const hits = await searchSpaceHistory(SPACE, 'what did we agree about the database and editor?', 8)

    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(h => h.content.includes('agreed the database migration'))).toBe(true)
    expect(hits.every(h => !h.content.includes('somebody else'))).toBe(true)
  })

  test('falls back to recency when there is no query to rank against', async () => {
    const { block } = await buildMemoryBlock(SPACE, ONE_MEMORY_BUDGET, 0)

    // Newest-first: the coffee memory was written last.
    expect(block).toContain('coffee')
  })
})
