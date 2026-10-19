/** Note authorship and review: a model's note must never pass as the user's, a mechanical edit must
 *  not change what the user vouched for, and Notes first must name the notes nobody checked. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { startFakeEmbeddings } from '../test-support/fake-embeddings.ts'
import { envOverride } from '../test-support/env-override.ts'

const { db, sqlite, users, uploadedFiles, setAppSetting, EMBED_DIMS } = await import('../db.ts')
const { eq } = await import('drizzle-orm')
const { saveNote, defaultModelLabel } = await import('./notes.ts')
const { trustByNote, trustInstruction } = await import('./note-trust.ts')
const { UNKNOWN_MODEL } = await import('../../../shared/note-trust.ts')
const { saveAgentNote, restoreRevision, linkNotesToAnswer } = await import('./agent-notes.ts')
const { noteRevisions } = await import('./note-revisions.ts')

const ME = 'trust-user'
let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  await db.insert(users).values({ id: ME, email: `${ME}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
})

afterAll(() => { server?.stop(); restoreEnv?.() })

beforeEach(() => { sqlite.run('DELETE FROM uploaded_files WHERE user_id = ?', [ME]) })

const row = async (id: string) => (await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, id)).get())!
const trustOf = (id: string) => trustByNote([id]).get(id)!

describe('authorship at creation', () => {
  test('a note is the user\'s unless a model is named as author', async () => {
    const mine = await saveNote(ME, { title: 'Mine', body: 'Text.' })
    const answer = await saveNote(ME, { title: 'Answer', body: 'Text.', author: 'model', model: 'GLM' })
    const split = await saveNote(ME, { title: 'Part', body: 'Text.', author: 'model' })
    expect(trustOf(mine).trust).toBe('yours')
    expect((await row(answer)).generatedBy).toBe('GLM')
    expect(trustOf(answer).trust).toBe('unreviewed')
    expect((await row(split)).generatedBy).toBe(defaultModelLabel())
  })

  test('reviewed at save is recorded', async () => {
    const id = await saveNote(ME, { title: 'Checked', body: 'Text.', author: 'model', reviewed: true })
    expect(trustOf(id).trust).toBe('reviewed')
  })
})

describe('changing trust', () => {
  test('an ordinary or mechanical edit leaves trust alone', async () => {
    const id = await saveNote(ME, { title: 'A', body: 'Text.', author: 'model', reviewed: true, status: 'draft' })
    await saveNote(ME, { id, title: 'A', body: 'Edited text.' }, { describe: false })
    const after = await row(id)
    expect(after.verifiedAt).not.toBeNull()
    expect(after.status).toBe('draft')
  })

  test('only an unknown author can be claimed, never a model\'s note', async () => {
    const model = await saveNote(ME, { title: 'M', body: 'Text.', author: 'model', model: 'GLM' })
    await saveNote(ME, { id: model, title: 'M', body: 'Text.', author: 'human' })
    expect((await row(model)).generatedBy).toBe('GLM')

    const old = await saveNote(ME, { title: 'Old', body: 'Text.' })
    sqlite.run('UPDATE uploaded_files SET generated_by = NULL WHERE id = ?', [old])
    expect(trustOf(old).trust).toBe('unknown')
    await saveNote(ME, { id: old, title: 'Old', body: 'Text.', author: 'human' })
    expect(trustOf(old).trust).toBe('yours')
  })

  test('an unknown author can be marked as a model, unnamed or named, but not changed after', async () => {
    const old = await saveNote(ME, { title: 'Old', body: 'Text.' })
    sqlite.run('UPDATE uploaded_files SET generated_by = NULL WHERE id = ?', [old])
    await saveNote(ME, { id: old, title: 'Old', body: 'Text.', author: 'model' })
    expect((await row(old)).generatedBy).toBe(UNKNOWN_MODEL)
    expect(trustOf(old).trust).toBe('unreviewed')
    await saveNote(ME, { id: old, title: 'Old', body: 'Text.', author: 'human' })
    expect((await row(old)).generatedBy).toBe(UNKNOWN_MODEL)

    const named = await saveNote(ME, { title: 'Named', body: 'Text.' })
    sqlite.run('UPDATE uploaded_files SET generated_by = NULL WHERE id = ?', [named])
    await saveNote(ME, { id: named, title: 'Named', body: 'Text.', author: 'model', model: 'GPT-4' })
    expect((await row(named)).generatedBy).toBe('GPT-4')
  })

  test('reviewing a draft makes it current, and the mark can be cleared', async () => {
    const id = await saveNote(ME, { title: 'D', body: 'Text.', author: 'model', status: 'draft' })
    await saveNote(ME, { id, title: 'D', body: 'Text.', reviewed: true })
    expect(trustOf(id)).toEqual({ trust: 'reviewed', status: 'stable', edited: false })
    await saveNote(ME, { id, title: 'D', body: 'Text.', reviewed: false })
    expect(trustOf(id).trust).toBe('unreviewed')
  })
})

describe('trustInstruction', () => {
  test('names unreviewed and unknown notes, and nothing when all are vouched for', async () => {
    const mine = await saveNote(ME, { title: 'Mine', body: 'Text.' })
    const model = await saveNote(ME, { title: 'Model', body: 'Text.', author: 'model' })
    const sources = [{ url: `file:${mine}`, label: 'N1' }, { url: `file:${model}`, label: 'N2' }]
    const line = trustInstruction(sources)
    expect(line).toContain('[N2]')
    expect(line).not.toContain('[N1]')
    expect(trustInstruction(sources.slice(0, 1))).toBe('')
  })

  test('an edited, unreviewed note is named apart from untouched drafts', async () => {
    const draft = await saveNote(ME, { title: 'Draft', body: 'Text.', author: 'model' })
    const edited = await saveNote(ME, { title: 'Edited', body: 'Text.', author: 'model' })
    await saveNote(ME, { id: edited, title: 'Edited', body: 'Better text.', edited: true })
    const lines = trustInstruction([{ url: `file:${draft}`, label: 'N1' }, { url: `file:${edited}`, label: 'N2' }]).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toStartWith('[N1] was written by a model')
    expect(lines[1]).toStartWith('[N2] was written by a model or by an unknown author and edited, but not reviewed')
  })
})

describe('edits by the owner', () => {
  test('changing a model\'s text marks it edited and keeps the model\'s version; it is not a review', async () => {
    const id = await saveNote(ME, { title: 'M', body: 'Model text.', author: 'model', model: 'GLM' })
    await saveNote(ME, { id, title: 'M', body: 'Model text.', edited: true, status: 'stable' })
    expect(trustOf(id).edited).toBe(false)
    await saveNote(ME, { id, title: 'M', body: 'My text.', edited: true })
    expect(trustOf(id)).toEqual({ trust: 'unreviewed', status: 'stable', edited: true })
    expect(noteRevisions(id).map(r => [r.body, r.actor])).toEqual([['Model text.', 'human']])
    await saveNote(ME, { id, title: 'M', body: 'My text, checked.', edited: true, reviewed: true })
    expect(trustOf(id).trust).toBe('reviewed')
  })

  test('the owner\'s own note, and a change by a process, are not marked', async () => {
    const mine = await saveNote(ME, { title: 'Own', body: 'Text.' })
    await saveNote(ME, { id: mine, title: 'Own', body: 'New text.', edited: true })
    const model = await saveNote(ME, { title: 'Relinked', body: 'Text.', author: 'model' })
    await saveNote(ME, { id: model, title: 'Relinked', body: 'Text, relinked.' })
    expect([trustOf(mine).edited, trustOf(model).edited, noteRevisions(mine).length]).toEqual([false, false, 0])
  })
})

describe('agent notes', () => {
  const docs = new Map([['C1', 'Paper one'], ['C2', 'Paper two']])
  const agent = (title: string, body: string, extra = {}) =>
    saveAgentNote(ME, { title, body, model: 'GLM', documents: docs, sourcesHeading: 'Sources', confidential: false, ...extra })

  test('must cite a document; the note is a model draft listing only what it cites', async () => {
    expect((await agent('Bare', 'No citations here.')).kind).toBe('refused')
    expect((await agent('Unknown', 'Cites [C9] only.')).kind).toBe('refused')
    const out = await agent('Contracts', 'Both use contracts [C2] [C1].')
    if (out.kind !== 'created') throw new Error(out.kind)
    const note = await row(out.id)
    expect(note.body).toContain('## Sources\n\n- **[C1]** Paper one\n- **[C2]** Paper two')
    expect([note.generatedBy, note.status, trustOf(out.id).trust]).toEqual(['GLM', 'draft', 'unreviewed'])
  })

  test('cites web results beside the documents, renumbered; a web result alone is not enough', async () => {
    const web = [{ title: 'KS test', url: 'https://a.example/ks' }, { title: 'FDR [overview]', url: 'https://b.example/fdr' }]
    expect((await agent('Web only', 'Explained [2].', { web })).kind).toBe('refused')
    const out = await agent('FDR correction', 'Controls the false discovery rate [2], used in [C1]; see also [2] and [7].', { web })
    if (out.kind !== 'created') throw new Error(out.kind)
    const { body } = await row(out.id)
    expect(body).toContain('false discovery rate [1], used in [C1]; see also [1] and [7].')
    expect(body).toContain('- **[C1]** Paper one\n- **[1]** [FDR overview](https://b.example/fdr)')
    expect(body).not.toContain('a.example')
  })

  test('reworks its own unreviewed draft and keeps the old version, which can be restored', async () => {
    const first = await agent('Idea', 'First take [C1].')
    const second = await agent('idea', 'Second take [C1].')
    expect(second).toMatchObject({ kind: 'updated', id: first.kind === 'created' ? first.id : '' })
    const id = (second as { id: string }).id
    const [rev] = noteRevisions(id)
    expect([rev.body.startsWith('First take'), rev.actor]).toEqual([true, 'GLM'])
    expect(await restoreRevision(ME, id, rev.id)).toBe(true)
    expect((await row(id)).body?.startsWith('First take')).toBe(true)
    expect(noteRevisions(id)[0].body.startsWith('Second take')).toBe(true)
    expect(await restoreRevision('someone-else', id, rev.id)).toBe(false)
  })

  test('never rewrites the user\'s note or a reviewed one: saves alongside, linking to it', async () => {
    const mine = await saveNote(ME, { title: 'Mine', body: 'My own words.' })
    const out = await agent('Mine', 'Model take [C1].')
    expect(out).toMatchObject({ kind: 'alongside', title: 'Mine (draft)', existing: 'Mine' })
    expect((await row(mine)).body).toBe('My own words.')
    expect((await row((out as { id: string }).id)).body).toContain('See also: [[Mine]]')

    const reviewed = await agent('Checked', 'Text [C1].')
    await saveNote(ME, { id: (reviewed as { id: string }).id, title: 'Checked', body: (await row((reviewed as { id: string }).id)).body!, reviewed: true })
    const beside = await agent('Checked', 'Rewrite [C1].')
    expect(beside.kind).toBe('alongside')
    // The next time, the draft beside it is reworked rather than another one added.
    expect(await agent('Checked', 'Again [C1].')).toMatchObject({ kind: 'updated', id: (beside as { id: string }).id, title: 'Checked (draft)' })
    expect((await row((beside as { id: string }).id)).body).toContain('See also: [[Checked]]')
  })

  test('a note written from confidential material is confidential, and links to its answer', async () => {
    const out = await agent('Secret', 'From a locked turn [C1].', { confidential: true })
    const id = (out as { id: string }).id
    expect((await row(id)).confidential).toBe(true)
    linkNotesToAnswer(ME, [id], 'chat-1', 'msg-1')
    linkNotesToAnswer('someone-else', [id], 'chat-2', 'msg-2')
    expect([(await row(id)).originSessionId, (await row(id)).originMessageId]).toEqual(['chat-1', 'msg-1'])
  })
})
