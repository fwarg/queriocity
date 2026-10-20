/** Tags and `[[wikilinks]]`: the user's own organisation of the library. Covers what would go wrong
 *  silently — a rename that strands the children of a tag or the links to a note, a summary pass
 *  that overwrites the user's tags, and anything crossing from one user's library into another's. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, sqlite, users, uploadedFiles, chatSessions, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { eq } = await import('drizzle-orm')
const { saveNote, renameResource, unlinkDeleted } = await import('./notes.ts')
const { normaliseTag, setResourceTags, listTags, renameTag, deleteTag, resourceTagList } = await import('./tags.ts')
const { suggestedTags } = await import('./tag-suggestions.ts')
const { parseWikilinks, linksOf } = await import('./links.ts')

const ME = 'zk-user'
const OTHER = 'zk-other'
let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  for (const id of [ME, OTHER]) {
    await db.insert(users).values({ id, email: `${id}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
  }
})

afterAll(() => { server?.stop(); restoreEnv?.() })

beforeEach(() => {
  for (const id of [ME, OTHER]) sqlite.run('DELETE FROM uploaded_files WHERE user_id = ?', [id])
})

const note = (userId: string, title: string, body = 'Some text.', extra = {}) => saveNote(userId, { title, body, ...extra })
const bodyOf = async (id: string) => (await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, id)).get())?.body

describe('normaliseTag', () => {
  test('lowercases, strips #, turns spaces into hyphens and tidies the hierarchy', () => {
    expect(normaliseTag('#Machine Learning / RAG ')).toBe('machine-learning/rag')
    expect(normaliseTag('Svensk historia')).toBe('svensk-historia')
    expect(normaliseTag('a//b/')).toBe('a/b')
    expect(normaliseTag(' # ')).toBe('')
  })
})

describe('inline tags', () => {
  test('#tags in a note join its tag field, alongside the field\'s own', async () => {
    const id = await note(ME, 'Inline', 'About #ml/rag here.', { tags: ['reading'] })
    expect(resourceTagList(id)).toEqual(['ml/rag', 'reading'])
    await saveNote(ME, { id, title: 'Inline', body: 'About #ml/rag and #bees now.' })
    expect(resourceTagList(id)).toEqual(['bees', 'ml/rag', 'reading'])
  })
})

describe('tags', () => {
  test('are set per resource, deduplicated, and unused ones disappear', async () => {
    const id = await note(ME, 'A')
    expect(setResourceTags(ME, id, ['ML/RAG', '#ml/rag', 'reading'])).toEqual(['ml/rag', 'reading'])
    expect(listTags(ME).map(t => t.path)).toEqual(['ml/rag', 'reading'])
    setResourceTags(ME, id, ['reading'])
    expect(listTags(ME).map(t => t.path)).toEqual(['reading'])
  })

  test('renaming a parent moves its children and merges into an existing tag', async () => {
    const a = await note(ME, 'A', 'x', { tags: ['ml', 'ml/rag'] })
    const b = await note(ME, 'B', 'y', { tags: ['machine-learning/rag'] })
    renameTag(ME, 'ml', 'machine-learning')
    expect(resourceTagList(a)).toEqual(['machine-learning', 'machine-learning/rag'])
    expect(resourceTagList(b)).toEqual(['machine-learning/rag'])
    expect(listTags(ME)).toEqual([{ path: 'machine-learning', count: 1 }, { path: 'machine-learning/rag', count: 2 }])
    expect(() => renameTag(ME, 'machine-learning', 'machine-learning/sub')).toThrow()
  })

  test('deleting a tag removes its subtree only, and never another user\'s', async () => {
    const mine = await note(ME, 'A', 'x', { tags: ['ml', 'ml/rag', 'mlops'] })
    const theirs = await note(OTHER, 'A', 'x', { tags: ['ml'] })
    deleteTag(ME, 'ml')
    expect(resourceTagList(mine)).toEqual(['mlops'])
    expect(resourceTagList(theirs)).toEqual(['ml'])
  })

  test('survive an edit to the note, which rewrites only the suggested topics', async () => {
    const id = await note(ME, 'A', 'first', { tags: ['keep'] })
    await saveNote(ME, { id, title: 'A', body: 'second' })
    expect(resourceTagList(id)).toEqual(['keep'])
  })

  test('suggestions are the topics, normalised, minus tags already carried', async () => {
    expect(await suggestedTags(ME, ['Machine Learning', 'RAG', 'rag'], ['rag'])).toEqual([{ path: 'machine-learning', existing: false }])
  })

  test('a topic naming an existing tag, or its last segment, is offered as that tag first', async () => {
    await note(ME, 'A', 'x', { tags: ['plants/roses', 'ml'] })
    const id = await note(ME, 'B', 'y')
    expect(await suggestedTags(ME, ['Tulips', 'Roses', 'ML'], resourceTagList(id))).toEqual([
      { path: 'plants/roses', existing: true }, { path: 'ml', existing: true }, { path: 'tulips', existing: false },
    ])
  })

  test('a topic close in meaning to a tag becomes that tag; parents of carried tags are not offered', async () => {
    await note(ME, 'A', 'x', { tags: ['gardening/roses'] })
    // Bag-of-words fake embeddings: the same words in another order are identical.
    expect(await suggestedTags(ME, ['Roses gardening', 'gardening'], ['gardening/roses/pruning'])).toEqual([])
    expect(await suggestedTags(ME, ['Roses gardening'], [])).toEqual([{ path: 'gardening/roses', existing: true }])
  })

  test('a topic only related to a tag is placed beside it, as a new tag', async () => {
    await note(ME, 'A', 'x', { tags: ['plants/garden-roses', 'tax'] })
    // Bag-of-words: two of three words shared (0.67) is related, not the same.
    expect(await suggestedTags(ME, ['Garden plants tulips', 'Bicycle repair'], [])).toEqual([
      { path: 'plants/garden-plants-tulips', existing: false }, { path: 'bicycle-repair', existing: false },
    ])
  })

  test('the match similarity is the admin setting', async () => {
    await note(ME, 'A', 'x', { tags: ['plants/garden-roses'] })
    await setAppSetting('tag_match_similarity', '0.5')
    try {
      expect(await suggestedTags(ME, ['Garden plants tulips'], [])).toEqual([{ path: 'plants/garden-roses', existing: true }])
    } finally { await setAppSetting('tag_match_similarity', '0.8') }
  })

  test('without embeddings, matching falls back to names', async () => {
    await note(ME, 'A', 'x', { tags: ['plants/roses'] })
    expect(await server.whileFailing(() => suggestedTags(ME, ['Roses', 'Rose garden care'], []))).toEqual([
      { path: 'plants/roses', existing: true }, { path: 'rose-garden-care', existing: false },
    ])
  })
})

describe('wikilinks', () => {
  test('parse titles and aliases, ignoring code', () => {
    expect(parseWikilinks('See [[Alpha]] and [[beta|the B]], [[alpha]] again, `[[code]]`\n```\n[[block]]\n```'))
      .toEqual(['Alpha', 'beta'])
  })

  test('resolve case-insensitively, show up as backlinks, and dangle until the target exists', async () => {
    const target = await note(ME, 'Ålder och minne')
    const src = await note(ME, 'Source', 'Links to [[ålder och minne]] and [[Later]].')
    expect(linksOf(ME, src).links.map(l => l.target?.id ?? null)).toEqual([target, null])
    expect(linksOf(ME, target).backlinks.map(b => b.id)).toEqual([src])

    const later = await note(ME, 'Later')
    expect(linksOf(ME, src).links[1].target?.id).toBe(later)
  })

  test('renaming a resource rewrites the notes linking to it, keeping aliases', async () => {
    const target = await note(ME, 'Old name')
    const src = await note(ME, 'Source', 'See [[Old name]] and [[old name|this]].')
    await renameResource(ME, target, 'Old name', 'New name')
    expect(await bodyOf(src)).toBe('See [[New name]] and [[New name|this]].')
    expect(linksOf(ME, target).backlinks.map(b => b.id)).toEqual([src])
  })

  test('unlinking a deleted note leaves plain text, an alias as its text, and other links alone', async () => {
    const target = await note(ME, 'Doomed')
    const other = await note(ME, 'Kept')
    const src = await note(ME, 'Source', 'See [[doomed]], [[Doomed|this one]] and [[Kept]].')
    await unlinkDeleted(ME, target, 'Doomed')
    expect(await bodyOf(src)).toBe('See doomed, this one and [[Kept]].')
    expect(linksOf(ME, src).links.map(l => l.target?.id ?? null)).toEqual([other])
  })

  test('renaming a note through saveNote relinks too', async () => {
    const target = await note(ME, 'Draft')
    const src = await note(ME, 'Source', 'About [[Draft]].')
    await saveNote(ME, { id: target, title: 'Final', body: 'Some text.' })
    expect(await bodyOf(src)).toBe('About [[Final]].')
  })

  test('never resolve to another user\'s resource', async () => {
    await note(OTHER, 'Secret plan')
    const src = await note(ME, 'Source', 'Is there a [[Secret plan]]?')
    expect(linksOf(ME, src).links[0].target).toBeNull()
  })
})

describe('chat of origin', () => {
  test('is kept for the owner\'s own chat and dropped for anyone else\'s', async () => {
    const now = new Date()
    await db.insert(chatSessions).values({ id: 'zk-chat', title: 'Diesel', userId: ME, createdAt: now, updatedAt: now })
    const mine = await note(ME, 'From chat', 'x', { originSessionId: 'zk-chat', originMessageId: 'm1' })
    const stolen = await note(OTHER, 'Sneaky', 'x', { originSessionId: 'zk-chat', originMessageId: 'm1' })
    const row = async (id: string) => db.select().from(uploadedFiles).where(eq(uploadedFiles.id, id)).get()
    expect((await row(mine))?.originSessionId).toBe('zk-chat')
    expect((await row(stolen))?.originSessionId).toBeNull()
    expect((await row(stolen))?.originMessageId).toBeNull()
    await db.delete(chatSessions).where(eq(chatSessions.id, 'zk-chat'))
  })
})
