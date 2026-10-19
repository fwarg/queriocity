/** "Tidy tags": proposals parsed safely from the small model, with similar tags handed over as hints. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { startFakeOpenAI } from '../test-support/fake-openai.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, users, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { saveNote } = await import('./notes.ts')
const { proposeTagTidy, parseTagChanges } = await import('./tag-tidy.ts')

const ME = 'tidy-user'
let embeddings: ReturnType<typeof startFakeEmbeddings>
let model: ReturnType<typeof startFakeOpenAI>
let restoreEnv: () => void

beforeAll(async () => {
  embeddings = startFakeEmbeddings(EMBED_DIMS)
  model = startFakeOpenAI([{ text: ['- #rose -> roses\nroses -> plants/roses\nTulips → Plants/Tulips\nunknown -> x\n'] }])
  restoreEnv = envOverride({
    EMBED_BASE_URL: embeddings.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed',
    CHAT_BASE_URL: model.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'fake',
  })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  await db.insert(users).values({ id: ME, email: `${ME}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
})

afterAll(() => { embeddings?.stop(); model?.stop(); restoreEnv?.() })

describe('tidy tags', () => {
  test('keeps renames of existing tags, dropping any that touch a tag an earlier one changes', () => {
    const totals = new Map([['rose', 1], ['roses', 2], ['tulips', 1], ['plants', 3], ['plants/ferns', 3]])
    const text = 'rose -> roses\nroses -> plants/roses\nplants -> plants/ferns/x\nplants/ferns -> ferns\ntulips -> plants/tulips\nnonsense'
    expect(parseTagChanges(text, totals)).toEqual([
      { from: 'rose', to: 'roses', count: 1, merges: true },
      { from: 'plants/ferns', to: 'ferns', count: 3, merges: false },
      { from: 'tulips', to: 'plants/tulips', count: 1, merges: false },
    ])
  })

  test('asks the small model with counts and similar-tag hints, and returns its valid changes', async () => {
    await saveNote(ME, { title: 'A', body: 'x', tags: ['roses', 'garden/roses', 'rose-garden'] })
    await saveNote(ME, { title: 'B', body: 'y', tags: ['rose', 'tulips', 'garden-rose'] })
    expect(await proposeTagTidy(ME)).toEqual([
      { from: 'rose', to: 'roses', count: 1, merges: true },
      { from: 'tulips', to: 'plants/tulips', count: 1, merges: false },
    ])
    const prompt = JSON.stringify(model.requests.at(-1))
    expect(prompt).toContain('- roses (1)')
    // Bag-of-words: the same words in another order are the same tag; `garden roses` and `roses` are not.
    expect(prompt).toMatch(/POSSIBLY THE SAME[^]*- (rose-garden ~ garden-rose|garden-rose ~ rose-garden)/)
    expect(prompt).not.toContain('roses ~')
  })
})
