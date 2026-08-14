/** Write-time conflict resolution, and the safety rule that protects user-authored memories.
 *
 *  The model decides ADD / UPDATE / NOOP for each incoming fact. The property worth guarding is
 *  not that it decides *well* — it is that a wrong decision cannot destroy something the user
 *  wrote or starred, and cannot silently lose a fact when the model or its transport fails. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { startFakeOpenAI } from './test-support/fake-openai.ts'

const { db, users, spaces, spaceMemories, EMBED_DIMS } = await import('./db.ts')
const { eq } = await import('drizzle-orm')

// Copied, not aliased, so afterAll can put them back. `mock.module` is process-wide and outlives
// this file, so a mock left in place is inherited by every test file that runs later: the writer
// tests were streaming against this file's stopped fake server, which surfaced as a timeout with
// no hint of where the model had come from. The spread is what makes the restore work — mocking
// mutates the live namespace object in place, so holding the namespace itself would hand back
// the mock and restore nothing.
const realEmbeddings = { ...(await import('./embeddings.ts')) }
const realLlm = { ...(await import('./llm.ts')) }

mock.module('./embeddings.ts', () => ({
  // Constant vector: every memory is equally "near", so candidate selection always returns the
  // full set and the test exercises the decision logic rather than the nearest-neighbour search.
  embedText: async () => Array(EMBED_DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
  embedTexts: async (texts: string[]) => texts.map(() => Array(EMBED_DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))),
}))

/** Whatever the planner asks, the fake model replies with this — reassigned per test.
 *  The script step reads it through a getter so one server serves every case. */
let plannerReply = '[]'
let server: ReturnType<typeof startFakeOpenAI>

beforeAll(async () => {
  server = startFakeOpenAI([{ get text() { return [plannerReply] } } as never])
  const model = createOpenAI({ baseURL: server.baseURL, apiKey: 'test' }).chat('fake-small')
  mock.module('./llm.ts', () => ({
    getSmallModel: () => model,
    getChatModel: () => model,
    getThinkingModelOrFallback: () => model,
    getEmbeddingModel: () => model,
    SMALL_MODEL_INPUT_CHARS: 7000,
  }))

  const now = new Date()
  await db.insert(users).values({
    id: 'cu', email: 'cu@example.com', name: null, role: 'user',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  await db.insert(spaces).values({ id: 'cs', name: 'cs', userId: 'cu', createdAt: now, updatedAt: now })
})

afterAll(() => {
  server?.stop()
  mock.module('./embeddings.ts', () => realEmbeddings)
  mock.module('./llm.ts', () => realLlm)
})

const { saveMemories, saveMemory } = await import('./memory.ts')

const contents = async () =>
  (await db.select().from(spaceMemories).where(eq(spaceMemories.spaceId, 'cs'))).map(m => m.content)

async function reset() {
  await db.delete(spaceMemories).where(eq(spaceMemories.spaceId, 'cs'))
}

describe('write-time conflict resolution', () => {
  test('a fact the model marks NOOP is not stored twice', async () => {
    await reset()
    await saveMemory('cs', 'The user works primarily in TypeScript', 'extraction')
    plannerReply = '[{"i":0,"op":"NOOP"}]'

    await saveMemories('cs', ['The user writes TypeScript'], 'extraction')

    expect(await contents()).toHaveLength(1)
  })

  test('an UPDATE replaces the superseded memory rather than adding beside it', async () => {
    await reset()
    await saveMemory('cs', 'The user runs Postgres', 'extraction')
    plannerReply = '[{"i":0,"op":"UPDATE","target":0}]'

    await saveMemories('cs', ['The user moved to SQLite'], 'extraction')

    const rows = await contents()
    expect(rows).toEqual(['The user moved to SQLite'])
  })

  test('a manual memory is never overwritten — the decision is downgraded to ADD', async () => {
    await reset()
    await saveMemory('cs', 'The user runs Postgres', 'manual')
    plannerReply = '[{"i":0,"op":"UPDATE","target":0}]'

    await saveMemories('cs', ['The user moved to SQLite'], 'extraction')

    const rows = await contents()
    expect(rows).toContain('The user runs Postgres')   // the user's own words survive
    expect(rows).toContain('The user moved to SQLite') // and the new fact is still kept
  })

  test('an always-keep memory is never overwritten either', async () => {
    await reset()
    const id = await saveMemory('cs', 'Never suggest cloud-hosted tools', 'extraction')
    await db.update(spaceMemories).set({ alwaysKeep: true }).where(eq(spaceMemories.id, id))
    plannerReply = '[{"i":0,"op":"UPDATE","target":0}]'

    await saveMemories('cs', ['The user is open to managed hosting'], 'extraction')

    expect(await contents()).toContain('Never suggest cloud-hosted tools')
  })

  test('unparseable model output adds every fact instead of dropping them', async () => {
    await reset()
    await saveMemory('cs', 'An unrelated existing memory', 'extraction')
    plannerReply = 'I am afraid I cannot help with that.'

    await saveMemories('cs', ['Fact one is new', 'Fact two is new'], 'extraction')

    const rows = await contents()
    expect(rows).toContain('Fact one is new')
    expect(rows).toContain('Fact two is new')
  })

  test('the model cannot file an identifier into the always-injected user profile', async () => {
    const { saveUserMemory, getUserMemories } = await import('./memory.ts')

    const rejected = await saveUserMemory('cu', 'The user can be reached at fredrik@example.com', 'tool')
    const kept = await saveUserMemory('cu', 'The user prefers answers in Swedish', 'tool')

    expect(rejected).toBe('')
    expect(kept).not.toBe('')
    const all = (await getUserMemories('cu')).map(m => m.content)
    expect(all.some(c => c.includes('@example.com'))).toBe(false)
  })

  test('a hand-typed entry is still the user\'s own decision', async () => {
    const { saveUserMemory, getUserMemories } = await import('./memory.ts')

    // Manual entry is not screened — refusing to store what someone deliberately typed about
    // themselves would be paternalistic, and it is not the model's choice.
    const id = await saveUserMemory('cu', 'Invoices go to billing@example.com', 'manual')

    expect(id).not.toBe('')
    expect((await getUserMemories('cu')).some(m => m.content.includes('billing@example.com'))).toBe(true)
  })

  test('the suggestion scan skips monitor runs and truncates inlined attachments', async () => {
    const { suggestUserMemories } = await import('./memory.ts')
    const { chatSessions, messages, monitorRuns, monitors } = await import('./db.ts')
    const { randomUUID } = await import('crypto')
    const now = new Date()

    const addSession = async (id: string, text: string) => {
      await db.insert(chatSessions).values({
        id, title: id, userId: 'cu', spaceId: null, createdAt: now, updatedAt: now, graduated: 0,
      })
      await db.insert(messages).values({
        id: randomUUID(), sessionId: id, role: 'user', content: text, createdAt: now,
      })
    }

    await addSession('plain-chat', 'I always want answers in Swedish. ' + 'ATTACHMENT_TAIL '.repeat(2000))
    await addSession('monitor-chat', 'MONITOR_PROMPT: report daily on semiconductors, be concise, cite sources.')
    await db.insert(monitors).values({
      id: 'mon1', userId: 'cu', name: 'm', promptText: 'p', focusMode: 'balanced',
      intervalMinutes: 60, keepCount: 3, isGlobal: false, spaceId: null, enabled: true,
      nextRunAt: null, lastRunAt: null, createdAt: now, updatedAt: now,
    })
    await db.insert(monitorRuns).values({
      id: 'run1', monitorId: 'mon1', userId: 'cu', sessionId: 'monitor-chat', runAt: now,
    })

    plannerReply = '- The user wants answers in Swedish'
    const before = server.requests.length
    await suggestUserMemories('cu')
    const sentRequests = server.requests.slice(before) as Array<{ messages: Array<{ role: string; content: string }> }>
    const sent = JSON.stringify(sentRequests)

    // A scheduled monitor prompt is not something the user said about themselves.
    expect(sent).not.toContain('MONITOR_PROMPT')
    expect(sent).toContain('answers in Swedish')

    // The 32k-char attachment must be cut down before it is sent, or one document displaces
    // every real exchange in the window.
    const userContent = sentRequests.flatMap(r => r.messages.filter(m => m.role === 'user'))
    expect(userContent).toHaveLength(1)
    expect(userContent[0].content.length).toBeLessThan(1400)
  })

  test('the scan depth is caller-selectable but bounded', async () => {
    const { suggestUserMemories } = await import('./memory.ts')
    const { chatSessions, messages } = await import('./db.ts')
    const { randomUUID } = await import('crypto')
    const now = new Date()

    // 12 further sessions, so a depth of 3 is genuinely narrower than the default.
    for (let i = 0; i < 12; i++) {
      const id = `depth-${i}`
      await db.insert(chatSessions).values({
        id, title: id, userId: 'cu', spaceId: null, createdAt: now, updatedAt: new Date(Date.now() + i * 1000), graduated: 0,
      })
      await db.insert(messages).values({
        id: randomUUID(), sessionId: id, role: 'user', content: `Depth probe number ${i}`, createdAt: now,
      })
    }
    plannerReply = 'NONE'

    const calls = async (limit?: number) => {
      const before = server.requests.length
      await suggestUserMemories('cu', limit)
      return server.requests.length - before
    }

    expect(await calls(3)).toBe(3)
    // A caller asking for the moon is clamped, not obeyed: one model call per session.
    expect(await calls(100_000)).toBeLessThanOrEqual(200)
    // Nonsense falls back to the default rather than scanning nothing.
    expect(await calls(0)).toBeGreaterThan(3)
  })

  test('one chat cannot dominate the suggestion list, and near-copies collapse', async () => {
    const { suggestUserMemories } = await import('./memory.ts')
    const { chatSessions, messages, userMemories } = await import('./db.ts')
    const { randomUUID } = await import('crypto')
    const now = new Date()

    await db.delete(userMemories).where(eq(userMemories.userId, 'cu'))
    await db.delete(chatSessions).where(eq(chatSessions.userId, 'cu'))
    for (let i = 0; i < 4; i++) {
      const id = `dom-${i}`
      await db.insert(chatSessions).values({
        id, title: id, userId: 'cu', spaceId: null, createdAt: now, updatedAt: new Date(Date.now() + i * 1000), graduated: 0,
      })
      await db.insert(messages).values({
        id: randomUUID(), sessionId: id, role: 'user', content: `Conversation number ${i}`, createdAt: now,
      })
    }

    // Every chat returns six lines: four topical, plus two rephrasings of the same trait — the
    // shape the real 100-chat scan produced.
    plannerReply = [
      '- The XR-9000 processor has 16 cores',
      '- The CEO of Acme Corp stepped down in March',
      '- The user asked about the new AI regulation',
      '- The new AI regulation defines four risk tiers',
      '- The user prefers concise answers with inline citations',
      '- The user prefers short answers that cite their sources inline',
    ].join('\n')

    const suggestions = await suggestUserMemories('cu', 4)

    expect(suggestions.every(s => /^(the )?user\b/i.test(s))).toBe(true)
    expect(suggestions.some(s => s.includes('XR-9000') || s.includes('Acme'))).toBe(false)

    // 24 candidates in, and no more than one row per distinct trait survives. Not exactly one:
    // word overlap collapses repeats and rewordings, but two genuine paraphrases sharing almost
    // no vocabulary still read as separate facts. Catching those needs semantics, and a threshold
    // low enough to merge them would also merge unrelated preferences.
    expect(suggestions.length).toBeLessThanOrEqual(2)
    expect(suggestions.length).toBeLessThan(4) // i.e. it does not scale with the number of chats
  })

  test('exact duplicates never reach the model at all', async () => {
    await reset()
    await saveMemory('cs', 'The user prefers concise answers with sources', 'extraction')
    plannerReply = '[{"i":0,"op":"ADD"}]' // would duplicate if the pre-filter were skipped

    await saveMemories('cs', ['The user prefers concise answers'], 'extraction')

    expect(await contents()).toHaveLength(1)
  })
})
