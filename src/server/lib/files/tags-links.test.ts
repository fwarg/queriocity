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
const { saveNote, renameResource } = await import('./notes.ts')
const { normaliseTag, setResourceTags, listTags, renameTag, deleteTag, resourceTagList, suggestedTags } = await import('./tags.ts')
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

  test('suggestions are the topics, normalised, minus tags already carried', () => {
    expect(suggestedTags(['Machine Learning', 'RAG', 'rag'], ['rag'])).toEqual(['machine-learning'])
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
