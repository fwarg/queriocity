/** Templates as recipes: the parts are stored, named back with the notes' trust, and a resource
 *  deleted or not the user's own is left out. A plain template is unaffected. */

// Must precede the imports below — they reach lib/auth.ts and lib/db.ts, which read env at load.
import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { startFakeEmbeddings } from '../lib/test-support/fake-embeddings.ts'
import { envOverride } from '../lib/test-support/env-override.ts'
import { db, sqlite, users, setAppSetting, EMBED_DIMS } from '../lib/db.ts'
import { saveNote } from '../lib/files/notes.ts'
import { templatesRouter } from './templates.ts'
import { signToken, AUTH_COOKIE } from '../lib/auth.ts'

const app = new Hono().route('/templates', templatesRouter)
const OWNER = 'tpl-owner'
const STRANGER = 'tpl-stranger'
const cookies: Record<string, string> = {}
let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  for (const id of [OWNER, STRANGER]) {
    await db.insert(users).values({ id, email: `${id}@tpl.test`, name: null, role: 'user', settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now })
    cookies[id] = `${AUTH_COOKIE}=${await signToken({ userId: id, email: `${id}@tpl.test`, role: 'user', tokenVersion: 0 })}`
  }
})

afterAll(() => { server?.stop(); restoreEnv?.() })

const call = async (path: string, { as = OWNER, method = 'GET', body }: { as?: string; method?: string; body?: unknown } = {}) =>
  (await app.request(`/templates${path}`, {
    method,
    headers: { Cookie: cookies[as], 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })).json()

describe('recipes', () => {
  test('stores the parts and names them back, with the instruction note\'s trust', async () => {
    const style = await saveNote(OWNER, { title: 'Style', body: 'Short.', author: 'model' })
    const example = await saveNote(OWNER, { title: 'Report 2024', body: 'Text.' })
    const theirs = await saveNote(STRANGER, { title: 'Theirs', body: 'Text.' })
    const created = await call('', { method: 'POST', body: {
      name: 'House style', promptText: 'Write about {{topic}}.', suggestedMode: 'thorough',
      instructionNoteIds: [style, theirs], exampleFileIds: [example],
      settings: { collectionMode: 'whole' },
    } })
    expect(created.instructions).toEqual([{ id: style, title: 'Style', trust: 'unreviewed' }])
    expect(created.examples).toEqual([{ id: example, title: 'Report 2024' }])
    expect(created.settings).toEqual({ collectionMode: 'whole' })

    // A deleted example drops out; clearing the instructions leaves the rest as they were.
    sqlite.run('DELETE FROM uploaded_files WHERE id = ?', [example])
    const updated = await call(`/${created.id}`, { method: 'PATCH', body: { instructionNoteIds: [] } })
    expect([updated.instructions, updated.examples, updated.settings, updated.name]).toEqual([[], [], { collectionMode: 'whole' }, 'House style'])
    expect((await call('', { as: STRANGER })).length).toBe(0)
  })

  test('a plain template has no parts', async () => {
    const plain = await call('', { method: 'POST', body: { name: 'Plain', promptText: 'Explain {{x}}.' } })
    expect([plain.instructions, plain.examples, plain.settings]).toEqual([[], [], {}])
  })
})
