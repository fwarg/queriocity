/** The topic map over a user's notes: grouping, signals, naming with its cache, bulk tagging. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { startFakeOpenAI } from '../test-support/fake-openai.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, sqlite, users, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { saveNote } = await import('./notes.ts')
const { topicMap, nameTopic, noteMap } = await import('./topics.ts')
const { addTagToResources, resourceTagList } = await import('./tags.ts')

const ME = 'tm-user'
const OTHER = 'tm-other'
const BEES = 'Honey bees pollinate apple orchards in the spring.'
const TAX = 'Quarterly VAT returns are due on the twelfth.'
let embeddings: ReturnType<typeof startFakeEmbeddings>
let model: ReturnType<typeof startFakeOpenAI>
let restoreEnv: () => void

beforeAll(async () => {
  embeddings = startFakeEmbeddings(EMBED_DIMS)
  model = startFakeOpenAI([{ text: ['name: Bee pollination\ntag: Bio/Bees'] }, { text: ['no idea'] }])
  restoreEnv = envOverride({
    EMBED_BASE_URL: embeddings.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed',
    CHAT_BASE_URL: model.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'fake',
  })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  for (const id of [ME, OTHER]) await db.insert(users).values({ id, email: `${id}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
})

afterAll(() => { embeddings?.stop(); model?.stop(); restoreEnv?.() })
beforeEach(() => { for (const id of [ME, OTHER]) sqlite.run('DELETE FROM uploaded_files WHERE user_id = ?', [id]) })

describe('topicMap', () => {
  test('groups similar notes, leaves small groups loose, and reports what the group lacks', async () => {
    const bees = [
      await saveNote(ME, { title: 'Bees 1', body: BEES, tags: ['bio/bees'] }),
      await saveNote(ME, { title: 'Bees 2', body: BEES, tags: ['bio/bees'] }),
      await saveNote(ME, { title: 'Bees 3', body: BEES, tags: ['tax'] }),
    ]
    // Tax 1 links to Bees 1, so one bee note has a link and two do not.
    const tax = [await saveNote(ME, { title: 'Tax 1', body: `${TAX} [[Bees 1]]` }), await saveNote(ME, { title: 'Tax 2', body: TAX })]
    await saveNote(OTHER, { title: 'Theirs', body: BEES })

    const map = topicMap(ME, 0.9)
    expect(map.topics).toHaveLength(1)
    const [topic] = map.topics
    expect(topic.members.map(m => m.id).sort()).toEqual([...bees].sort())
    expect(topic.topTag).toEqual({ path: 'bio/bees', count: 2 })
    expect(topic.tagSpread).toBe(2)
    expect(topic.unlinked).toBe(2)
    // Identical text: every pair is a near-duplicate.
    expect(topic.duplicates).toHaveLength(3)
    expect(map.loose.map(m => m.id).sort()).toEqual([...tax].sort())
  })

  test('names a topic once, then serves it from the cache; a failed name is not cached', async () => {
    const ids = [
      await saveNote(ME, { title: 'A', body: BEES }), await saveNote(ME, { title: 'B', body: BEES }), await saveNote(ME, { title: 'C', body: BEES }),
    ]
    expect(await nameTopic(ME, ids)).toMatchObject({ name: 'Bee pollination', tag: 'bio/bees' })
    const calls = model.callCount
    expect(await nameTopic(ME, [...ids].reverse())).toMatchObject({ name: 'Bee pollination' })
    expect(model.callCount).toBe(calls)
    expect(topicMap(ME, 0.9).topics[0].name).toBe('Bee pollination')

    const other = [ids[0], ids[1]]
    expect(await nameTopic(ME, other)).toMatchObject({ name: 'A', tag: null })
    await expect(nameTopic(OTHER, ids)).rejects.toThrow()
  })
})

describe('maps', () => {
  // Bag-of-words fake embeddings: A and B share four of five words (cosine 0.8), C shares none.
  const A = 'bees pollinate apple orchards early'
  const B = 'bees pollinate apple orchards late'
  const C = 'quarterly vat returns are due'

  async function library() {
    const ids: Record<string, string[]> = { A: [], B: [], C: [] }
    for (const [group, text] of Object.entries({ A, B, C })) {
      for (let i = 1; i <= 3; i++) ids[group].push(await saveNote(ME, { title: `${group}${i}`, body: text }))
    }
    return ids
  }

  test('relations join related topics and leave an unrelated one out', async () => {
    await library()
    const map = topicMap(ME, 0.9)
    expect(map.topics).toHaveLength(3)
    const title = (key: string) => map.topics.find(tp => tp.key === key)!.members[0].title[0]
    expect(map.relations.map(r => [title(r.a), title(r.b)].sort().join(''))).toEqual(['AB'])
  })

  test('the note map joins similar notes above the floor, adds real links, and can show one topic', async () => {
    const ids = await library()
    const all = noteMap(ME, 0.9)!
    expect(all.nodes).toHaveLength(9)
    const groupOf = (id: string) => Object.entries(ids).find(([, list]) => list.includes(id))![0]
    // A and B notes are within the floor (0.8 ≥ 0.9 − 0.1); C notes are joined only to each other.
    expect(all.similar.every(e => groupOf(e.a) === 'C' ? groupOf(e.b) === 'C' : groupOf(e.b) !== 'C')).toBe(true)
    expect(all.similar.length).toBeGreaterThan(0)

    const topicA = topicMap(ME, 0.9).topics.find(tp => tp.members.some(m => m.id === ids.A[0]))!
    const one = noteMap(ME, 0.9, { topic: topicA.key })!
    expect(one.nodes.map(n => n.id).sort()).toEqual([...ids.A].sort())
    expect(noteMap(ME, 0.9, { topic: 'no-such-topic' })).toBeNull()
  })

  test('the note map draws explicit links among its notes', async () => {
    const ids = await library()
    const linker = await saveNote(ME, { title: 'Linker', body: `${C} See [[A1]].` })
    const map = noteMap(ME, 0.9)!
    expect(map.links).toContainEqual({ a: linker, b: ids.A[0] })
  })
})

describe('addTagToResources', () => {
  test('adds a tag, keeps the others, and skips resources the user does not own', async () => {
    const mine = await saveNote(ME, { title: 'Mine', body: BEES, tags: ['reading'] })
    const theirs = await saveNote(OTHER, { title: 'Theirs', body: BEES })
    expect(addTagToResources(ME, [mine, theirs], 'Bio/Bees')).toBe(1)
    expect(resourceTagList(mine)).toEqual(['bio/bees', 'reading'])
    expect(resourceTagList(theirs)).toEqual([])
  })
})
