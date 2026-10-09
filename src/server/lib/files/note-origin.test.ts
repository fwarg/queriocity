/** Backfilling the chat of origin for notes saved from answers before it was recorded. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, users, chatSessions, messages, uploadedFiles, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { eq } = await import('drizzle-orm')
const { saveNote } = await import('./notes.ts')
const { backfillNoteOrigins, answerKey } = await import('./note-origin.ts')

const ME = 'origin-user'
const OTHER = 'origin-other'
let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

const ANSWER = 'Honey bees pollinate apple orchards [1, 2], and **wild bees** do much of the work in cold springs [3]. See [the survey](https://example.com) for numbers.'

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  for (const id of [ME, OTHER]) {
    await db.insert(users).values({ id, email: `${id}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
    await db.insert(chatSessions).values({ id: `${id}-chat`, title: 'Bees', userId: id, createdAt: now, updatedAt: now })
    await db.insert(messages).values({ id: `${id}-answer`, sessionId: `${id}-chat`, role: 'assistant', content: ANSWER, createdAt: now })
  }
})

afterAll(() => { server?.stop(); restoreEnv?.() })

const originOf = async (id: string) => db.select({ s: uploadedFiles.originSessionId, m: uploadedFiles.originMessageId }).from(uploadedFiles).where(eq(uploadedFiles.id, id)).get()

describe('backfillNoteOrigins', () => {
  test('links a note to the answer it was saved from, only within its owner\'s chats, once', async () => {
    const saved = await saveNote(ME, { title: 'Bees', body: 'Honey bees pollinate apple orchards [1][2], and **wild bees** do much of the work in cold springs [3]. See the survey for numbers.\n\n---\n\n## Sources\n\n- **[1]** [A](https://a.example)' })
    const unrelated = await saveNote(ME, { title: 'Tax', body: 'Quarterly VAT returns are due on the twelfth of the month after the quarter ends, always.' })
    await setAppSetting('note_origin_backfill_done', 'false')

    expect(await backfillNoteOrigins()).toBe(1)
    expect(await originOf(saved)).toEqual({ s: `${ME}-chat`, m: `${ME}-answer` })
    expect((await originOf(unrelated))?.s).toBeNull()
    expect(await backfillNoteOrigins()).toBe(0)
  })

  test('the key ignores citation markers, links and emphasis', () => {
    expect(answerKey('A **b** [1, 2] [c](http://x) [F1]')).toBe(answerKey('A b  c'))
  })
})
