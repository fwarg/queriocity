/** AI-suggested links: candidates from similar content, the model's pick and phrase, accepting in
 *  place or under See also, and dismissals that stick. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { startFakeOpenAI } from '../test-support/fake-openai.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, sqlite, users, uploadedFiles, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { eq } = await import('drizzle-orm')
const { saveNote } = await import('./notes.ts')
const { suggestLinks, acceptLink, dismissLink, findPhrase } = await import('./link-suggest.ts')

const ME = 'ls-user'
const TEXT = 'Honey bees pollinate apple orchards in the spring.'
const NO_FLOOR = { minSimilarity: 0, minRelevance: 0 }
let embeddings: ReturnType<typeof startFakeEmbeddings>
let model: ReturnType<typeof startFakeOpenAI>
let restoreEnv: () => void

beforeAll(async () => {
  embeddings = startFakeEmbeddings(EMBED_DIMS)
  model = startFakeOpenAI(Array.from({ length: 10 }, () => ({ text: ['[{"n":1,"phrase":"apple orchards","reason":"Same orchards."}]'] })))
  restoreEnv = envOverride({
    EMBED_BASE_URL: embeddings.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed',
    CHAT_BASE_URL: model.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'fake', RERANK_MODEL: '',
  })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  await db.insert(users).values({ id: ME, email: `${ME}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
})

afterAll(() => { embeddings?.stop(); model?.stop(); restoreEnv?.() })
beforeEach(() => { sqlite.run('DELETE FROM uploaded_files WHERE user_id = ?', [ME]) })

const bodyOf = async (id: string) => (await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, id)).get())?.body

describe('link suggestions', () => {
  test('proposes a similar note with the phrase to link from, and accepting links it in place', async () => {
    const note = await saveNote(ME, { title: 'Bees', body: TEXT })
    const twin = await saveNote(ME, { title: 'Orchards', body: TEXT })
    const [s] = await suggestLinks(ME, note, NO_FLOOR)
    expect(s).toEqual({ targetId: twin, title: 'Orchards', phrase: 'apple orchards', reason: 'Same orchards.' })

    await acceptLink(ME, note, twin, s.phrase, 'See also')
    expect(await bodyOf(note)).toBe('Honey bees pollinate [[Orchards|apple orchards]] in the spring.')
    // Now linked, so no longer suggested.
    expect(await suggestLinks(ME, note, NO_FLOOR)).toEqual([])
  })

  test('without a phrase the link goes under See also; a dismissal is never suggested again', async () => {
    const note = await saveNote(ME, { title: 'Bees', body: TEXT })
    const twin = await saveNote(ME, { title: 'Orchards', body: TEXT })
    await acceptLink(ME, note, twin, 'not in the note', 'See also')
    expect(await bodyOf(note)).toBe(`${TEXT}\n\n## See also\n\n- [[Orchards]]`)

    const other = await saveNote(ME, { title: 'Other', body: TEXT })
    dismissLink(ME, other, note)
    dismissLink(ME, other, twin)
    expect(await suggestLinks(ME, other, NO_FLOOR)).toEqual([])
  })

  test('the phrase is found in prose only, exact case first', () => {
    const body = '# Bees\nSee [[Bees]] and `bees` code. Wild Bees and bees.'
    expect(findPhrase(body, 'bees')).toBe(body.lastIndexOf('bees'))
    expect(findPhrase(body, 'wild bees')).toBe(body.indexOf('Wild Bees'))
    expect(findPhrase(body, 'Bees')).toBe(body.indexOf('Wild Bees') + 5)
  })
})
