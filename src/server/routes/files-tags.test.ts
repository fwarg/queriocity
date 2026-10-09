/** Tags, links and the chat of origin through the routes the UI calls — including that `/tags` is
 *  not mistaken for a resource id, and that a stranger can neither read nor set anything. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { startFakeEmbeddings } from '../lib/test-support/fake-embeddings.ts'
import { envOverride } from '../lib/test-support/env-override.ts'
import { db, sqlite, users, chatSessions, messages, setAppSetting, EMBED_DIMS } from '../lib/db.ts'
import { filesRouter } from './files.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'

const app = new Hono().route('/files', filesRouter)
const OWNER = 'tags-owner'
const STRANGER = 'tags-stranger'
const cookies: Record<string, string> = {}
let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  for (const id of [OWNER, STRANGER]) {
    await db.insert(users).values({ id, email: `${id}@tags.test`, name: null, role: 'user', settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now })
    cookies[id] = `${AUTH_COOKIE}=${await signToken({ userId: id, email: `${id}@tags.test`, role: 'user', tokenVersion: 0 })}`
  }
  await db.insert(chatSessions).values({ id: 'tags-chat', title: 'Bees', userId: OWNER, createdAt: now, updatedAt: now })
})

afterAll(() => { server?.stop(); restoreEnv?.() })

beforeEach(() => {
  for (const id of [OWNER, STRANGER]) sqlite.run('DELETE FROM uploaded_files WHERE user_id = ?', [id])
})

const call = (path: string, { as = OWNER, method = 'GET', body }: { as?: string; method?: string; body?: unknown } = {}) =>
  app.request(`/files${path}`, {
    method,
    headers: { Cookie: cookies[as], 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const createNote = async (body: Record<string, unknown>) => (await (await call('/notes', { method: 'POST', body })).json()).id as string

describe('tag routes', () => {
  test('set, list, rename and delete tags', async () => {
    const id = await createNote({ title: 'Hives', body: 'About [[Bees]].', tags: ['Biology/Insects'] })
    expect((await (await call(`/${id}/tags`, { method: 'PUT', body: { tags: ['biology/insects', 'reading'] } })).json()).tags)
      .toEqual(['biology/insects', 'reading'])
    expect(await (await call('/tags')).json()).toEqual([{ path: 'biology/insects', count: 1 }, { path: 'reading', count: 1 }])

    expect((await call('/tags', { method: 'PATCH', body: { from: 'biology', to: 'nature' } })).status).toBe(200)
    expect((await call('/tags?path=reading', { method: 'DELETE' })).status).toBe(200)
    const listed = await (await call('')).json() as Array<{ id: string; tags: string[] }>
    expect(listed.find(r => r.id === id)?.tags).toEqual(['nature/insects'])
  })

  test('a stranger can neither tag nor read another user\'s resource', async () => {
    const id = await createNote({ title: 'Mine', body: 'x' })
    expect((await call(`/${id}/tags`, { as: STRANGER, method: 'PUT', body: { tags: ['x'] } })).status).toBe(404)
    expect((await call(`/${id}`, { as: STRANGER })).status).toBe(404)
  })
})

describe('resource detail', () => {
  test('carries tags, links both ways and the chat of origin', async () => {
    const bees = await createNote({ title: 'Bees', body: 'Pollinators.', originSessionId: 'tags-chat', originMessageId: 'msg-1' })
    const hives = await createNote({ title: 'Hives', body: 'Where [[Bees]] live; see [[Honey]].', tags: ['nature'] })

    const target = await (await call(`/${bees}`)).json()
    expect(target.backlinks.map((b: { id: string }) => b.id)).toEqual([hives])
    expect(target.originChat).toEqual({ id: 'tags-chat', title: 'Bees', messageId: 'msg-1' })

    const source = await (await call(`/${hives}`)).json()
    expect(source.tags).toEqual(['nature'])
    expect(source.links.map((l: { title: string; target: { id: string } | null }) => [l.title, l.target?.id ?? null]))
      .toEqual([['Bees', bees], ['Honey', null]])
  })
})

describe('library graph and link counts', () => {
  test('connects only the caller\'s linked resources, narrows by tag subtree, and counts links', async () => {
    const hub = await createNote({ title: 'Hub', body: 'See [[Leaf]] and [[Other]].', tags: ['bio/bees'], originSessionId: 'tags-chat' })
    const leaf = await createNote({ title: 'Leaf', body: 'Leaf.', tags: ['bio'] })
    const other = await createNote({ title: 'Other', body: 'Other.', tags: ['tax'] })
    const lonely = await createNote({ title: 'Lonely', body: 'Nothing links here.' })
    await call('/notes', { as: STRANGER, method: 'POST', body: { title: 'Theirs', body: 'See [[Hub]].' } })

    const all = await (await call('/graph')).json() as { nodes: Array<{ id: string; group?: string }>; edges: unknown[]; truncated: boolean }
    expect(all.nodes.map(n => n.id).sort()).toEqual([hub, leaf, other].sort())
    expect(all.nodes.find(n => n.id === hub)?.group).toBe('bio')
    expect(all.truncated).toBe(false)

    const bio = await (await call('/graph?tag=bio')).json() as { nodes: Array<{ id: string }> }
    expect(bio.nodes.map(n => n.id).sort()).toEqual([hub, leaf].sort())

    const withChats = await (await call('/graph?chats=1')).json() as { nodes: Array<{ id: string; kind: string }> }
    expect(withChats.nodes.some(n => n.kind === 'chat')).toBe(true)

    const listed = await (await call('')).json() as Array<{ id: string; linkCount: number }>
    const count = (id: string) => listed.find(r => r.id === id)?.linkCount
    expect([count(hub), count(leaf), count(lonely)]).toEqual([2, 1, 0])
  })
})

describe('Obsidian export', () => {
  test('zips the caller\'s notes with frontmatter and links pointing at file names, nobody else\'s', async () => {
    await createNote({ title: 'A/B: odd', body: 'Body.', tags: ['bio'] })
    await createNote({ title: 'Linker', body: 'See [[A/B: odd]] and [[A/B: odd|that]].' })
    await call('/notes', { as: STRANGER, method: 'POST', body: { title: 'Theirs', body: 'Secret.' } })

    const res = await call('/export/obsidian')
    expect(res.headers.get('content-type')).toBe('application/zip')
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))
    expect(text).toContain('Notes/A B odd.md')
    expect(text).toContain('aliases:\n  - "A/B: odd"')
    expect(text).toContain('tags:\n  - "bio"')
    expect(text).toContain('[[A B odd|A/B: odd]] and [[A B odd|that]]')
    expect(text).not.toContain('Secret.')
  })
})

describe('full Obsidian export', () => {
  test('adds chats as markdown with image links into Images/, and notes link to their chat', async () => {
    const now = new Date()
    await db.insert(messages).values([
      { id: 'exp-q', sessionId: 'tags-chat', role: 'user', content: 'Draw a bee', createdAt: now },
      { id: 'exp-a', sessionId: 'tags-chat', role: 'assistant', content: 'Here: ![bee](/images/tags-owner/bee-1.png)', sources: JSON.stringify([{ title: 'Bees', url: 'https://bees.example' }]), createdAt: now },
    ])
    await createNote({ title: 'From chat', body: 'Body.', originSessionId: 'tags-chat' })

    const plain = new TextDecoder().decode(new Uint8Array(await (await call('/export/obsidian')).arrayBuffer()))
    expect(plain).not.toContain('Chats/')
    const full = new TextDecoder().decode(new Uint8Array(await (await call('/export/obsidian?full=1')).arrayBuffer()))
    expect(full).toContain('Chats/Bees.md')
    expect(full).toContain('## You\n\nDraw a bee\n\n## Assistant\n\nHere: ![bee](../Images/bee-1.png)\n\n- **[1]** [Bees](https://bees.example)')
    expect(full).toContain('saved_from_chat: "[[Bees]]"')
  })
})

describe('POST /files/extract', () => {
  test('says when the attachment was cut to the limit', async () => {
    await setAppSetting('attachment_chars', '10')
    const form = new FormData()
    form.append('file', new File(['Line of text. '.repeat(5)], 'long.txt', { type: 'text/plain' }))
    const res = await app.request('/files/extract', { method: 'POST', headers: { Cookie: cookies[OWNER] }, body: form })
    expect(await res.json()).toMatchObject({ filename: 'long.txt', content: 'Line of te', truncated: true, totalChars: 70 })
    await setAppSetting('attachment_chars', '20000')
  })
})
