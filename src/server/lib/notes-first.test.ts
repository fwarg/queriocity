/** "Notes first" retrieval: only the user's notes, then the opening of the notes they link with. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { startFakeEmbeddings } from './test-support/fake-embeddings.ts'
import { envOverride } from './test-support/env-override.ts'

const { db, users, uploadedFiles, setAppSetting, EMBED_DIMS } = await import('./db.ts')
const { saveNote } = await import('./files/notes.ts')
const { indexResourceText } = await import('./files/ingest.ts')
const { buildNotesBlock } = await import('./memory.ts')

const ME = 'nf-user'
const OTHER = 'nf-other'
const TEXT = 'Honey bees pollinate apple orchards in the spring.'
let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed', RERANK_MODEL: '' })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  for (const id of [ME, OTHER]) await db.insert(users).values({ id, email: `${id}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
})

afterAll(() => { server?.stop(); restoreEnv?.() })

describe('buildNotesBlock', () => {
  test('cites the matching note and the note it links to, never a file or another user\'s note', async () => {
    await saveNote(ME, { title: 'Bees', body: `${TEXT} See [[Soil]].` })
    await saveNote(ME, { title: 'Soil', body: 'Loam drains well and keeps roots healthy.' })
    await saveNote(OTHER, { title: 'Theirs', body: TEXT })
    const now = new Date()
    await db.insert(uploadedFiles).values({ id: 'nf-file', userId: ME, filename: 'paper.pdf', mimeType: 'application/pdf', size: 1, kind: 'file', createdAt: now, updatedAt: now })
    await indexResourceText('nf-file', TEXT, 'application/pdf', 0)

    const { block, fileSources } = await buildNotesBlock(ME, TEXT, 1500)
    expect(fileSources.map(s => s.title)).toEqual(['[N1] Bees', '[N2] Soil'])
    expect(block).toContain('Loam drains well')
    expect(block).toContain('from their own notes first')
  })

  test('is empty without a query or budget', async () => {
    expect((await buildNotesBlock(ME, '', 1500)).block).toBe('')
    expect((await buildNotesBlock(ME, TEXT, 0)).block).toBe('')
  })
})
