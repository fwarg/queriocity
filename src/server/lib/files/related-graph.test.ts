/** Related resources (content similarity), the local graph (explicit connections) and "See also"
 *  links — each scoped to one user's library. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, sqlite, users, uploadedFiles, chatSessions, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { eq } = await import('drizzle-orm')
const { saveNote, addSeeAlso } = await import('./notes.ts')
const { relatedResources } = await import('./related.ts')
const { localGraph, chatNodeId } = await import('./graph.ts')
const { addUnderHeading } = await import('./links.ts')

const ME = 'rg-user'
const OTHER = 'rg-other'
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

beforeEach(async () => {
  for (const id of [ME, OTHER]) {
    sqlite.run('DELETE FROM uploaded_files WHERE user_id = ?', [id])
    await db.delete(chatSessions).where(eq(chatSessions.userId, id))
  }
})

const note = (title: string, body: string, extra = {}, userId = ME) => saveNote(userId, { title, body, ...extra })
const bodyOf = async (id: string) => (await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, id)).get())?.body

describe('relatedResources', () => {
  const TEXT = 'Honey bees pollinate apple orchards in the spring.'

  test('finds the closest resource, never itself, flags existing links and hints shared tags', async () => {
    const target = await note('Bees', TEXT)
    const twin = await note('Pollination', TEXT, { tags: ['nature/insects'] })
    await note('Other twin', TEXT, { tags: ['nature/insects'] })
    const linker = await note('Linker', `${TEXT} See [[Bees]].`)

    const { related, tags } = await relatedResources(ME, target)
    expect(related.map(r => r.id)).not.toContain(target)
    expect(related.map(r => r.id)).toContain(twin)
    expect(related.find(r => r.id === linker)?.linked).toBe(true)
    expect(related.find(r => r.id === twin)?.linked).toBe(false)
    expect(tags).toEqual([{ path: 'nature/insects', count: 2 }])
  })

  test('leaves out a resource below the similarity threshold, even when nothing else is closer', async () => {
    const target = await note('Bees', TEXT)
    const twin = await note('Pollination', TEXT)
    const unrelated = await note('Tax', 'Quarterly VAT returns are due on the twelfth.')

    expect((await relatedResources(ME, target)).related.map(r => r.id)).toContain(unrelated)
    const ids = (await relatedResources(ME, target, { minSimilarity: 0.5, minRelevance: 0.5 })).related.map(r => r.id)
    expect(ids).toContain(twin)
    expect(ids).not.toContain(unrelated)
  })

  test('never reaches another user\'s library', async () => {
    const target = await note('Bees', TEXT)
    await note('Theirs', TEXT, {}, OTHER)
    expect((await relatedResources(ME, target)).related).toEqual([])
  })
})

describe('localGraph', () => {
  test('walks links and chats of origin to the given depth, both directions', async () => {
    const now = new Date()
    await db.insert(chatSessions).values({ id: 'rg-chat', title: 'Bee chat', userId: ME, createdAt: now, updatedAt: now })
    const a = await note('A', 'Root, links [[B]].', { originSessionId: 'rg-chat' })
    const b = await note('B', 'Links [[C]].')
    const c = await note('C', 'Leaf.')
    const sibling = await note('Sibling', 'Same chat.', { originSessionId: 'rg-chat' })

    const one = localGraph(ME, a, 1)
    expect(one.nodes.map(n => n.id).sort()).toEqual([a, b, chatNodeId('rg-chat')].sort())
    expect(one.nodes.find(n => n.id === chatNodeId('rg-chat'))).toMatchObject({ kind: 'chat', label: 'Bee chat', depth: 1 })

    const two = localGraph(ME, a, 2)
    expect(two.nodes.map(n => n.id).sort()).toEqual([a, b, c, sibling, chatNodeId('rg-chat')].sort())
    expect(two.edges).toContainEqual({ source: b, target: c, kind: 'link' })

    // From the leaf, backlinks lead back up.
    expect(localGraph(ME, c, 1).nodes.map(n => n.id).sort()).toEqual([b, c].sort())
  })

  test('a lone resource is just itself', async () => {
    const alone = await note('Alone', 'Nothing links here.')
    expect(localGraph(ME, alone, 2)).toEqual({ nodes: [{ id: alone, label: 'Alone', kind: 'note', depth: 0 }], edges: [] })
  })
})

describe('See also', () => {
  test('adds a section once, appends to it, and skips a link already present', async () => {
    const src = await note('Source', 'Body text.')
    const x = await note('X', 'x')
    const y = await note('Y', 'y')
    await addSeeAlso(ME, src, x, 'See also')
    await addSeeAlso(ME, src, y, 'See also')
    await addSeeAlso(ME, src, x, 'See also')
    expect(await bodyOf(src)).toBe('Body text.\n\n## See also\n\n- [[X]]\n- [[Y]]')
  })

  test('refuses another user\'s note or target', async () => {
    const mine = await note('Mine', 'x')
    const theirs = await note('Theirs', 'y', {}, OTHER)
    await expect(addSeeAlso(ME, mine, theirs, 'See also')).rejects.toThrow()
    await expect(addSeeAlso(ME, theirs, mine, 'See also')).rejects.toThrow()
  })

  test('inserts before a following section', () => {
    expect(addUnderHeading('A\n\n## See also\n\n- [[X]]\n\n## Later\ntext', 'See also', '- [[Y]]'))
      .toBe('A\n\n## See also\n\n- [[X]]\n- [[Y]]\n\n## Later\ntext\n')
  })
})
