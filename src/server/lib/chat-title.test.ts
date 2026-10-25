/** Chat titles: what the chat reads names it, a weak title is marked for the small model, and the
 *  model's title replaces it once — never over a title the user chose. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import { startFakeOpenAI } from './test-support/fake-openai.ts'
import { envOverride } from './test-support/env-override.ts'

const { db, sqlite, users, spaces, uploadedFiles, chatSessions, messages, setAppSetting } = await import('./db.ts')
const { questionOf, cutAtWord, cleanTitle, initialChatTitle, refineChatTitle } = await import('./chat-title.ts')

const ME = 'title-user'
let restore: (() => void) | null = null
let fake: ReturnType<typeof startFakeOpenAI> | null = null

beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({ id: ME, email: `${ME}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
  await db.insert(uploadedFiles).values({ id: 'title-doc', userId: ME, filename: 'Attention is all you need.pdf', mimeType: 'application/pdf', size: 1, kind: 'file', createdAt: now, updatedAt: now })
  await db.insert(spaces).values({ id: 'title-coll', userId: ME, name: 'Transformers', kind: 'collection', createdAt: now, updatedAt: now })
})

afterEach(() => { fake?.stop(); fake = null; restore?.(); restore = null })

async function chat(id: string, title: string, scope: string | null) {
  const now = new Date()
  await db.insert(chatSessions).values({ id, title, autoTitleScope: scope, userId: ME, createdAt: now, updatedAt: now })
  await db.insert(messages).values({ id: `${id}-q`, sessionId: id, role: 'user', content: 'Compile the document into notes, one per concept.', createdAt: now })
  await db.insert(messages).values({ id: `${id}-a`, sessionId: id, role: 'assistant', content: 'Saved 6 notes on attention.', createdAt: new Date(now.getTime() + 1) })
}

const titleOf = (id: string) => (sqlite.query('SELECT title, auto_title_scope AS scope FROM chat_sessions WHERE id = ?').get(id) as { title: string; scope: string | null })

describe('initial titles', () => {
  test('filler openings and attached text are dropped; cuts fall on a word', () => {
    expect(questionOf('Can you please explain RoPE?\n\n---\n[paper.pdf]\nlong text')).toBe('Explain RoPE?')
    expect(questionOf('kan du förklara RoPE')).toBe('Förklara RoPE')
    expect(cutAtWord('one two three four', 12)).toBe('one two…')
  })

  test('the document or collection read prefixes the title, and a long question is marked weak', () => {
    const long = 'Compile the document into notes, one note per concept, citing it for every claim it supports'
    const doc = initialChatTitle(long, { documentIds: ['title-doc'], collections: ['title-coll'] })
    expect(doc.title.startsWith('Attention is all you need.pdf: Compile')).toBe(true)
    expect(doc.title.length).toBeLessThanOrEqual(60)
    expect(doc.scope).toBe('Attention is all you need.pdf')
    expect(initialChatTitle(long, { documentIds: [], collections: ['title-coll'] }).title.startsWith('Transformers: ')).toBe(true)
  })

  test('a clear question needs no model; a short one borrows its attachment\'s name', () => {
    expect(initialChatTitle('How does rotary position embedding work?', { documentIds: [], collections: [] }))
      .toEqual({ title: 'How does rotary position embedding work?', scope: null })
    expect(initialChatTitle('Summarise this', { documentIds: [], collections: [], attachedFileIds: ['title-doc'] }))
      .toEqual({ title: 'Attention is all you need.pdf: Summarise this', scope: 'Attention is all you need.pdf' })
  })

  test('the admin can turn the model off', async () => {
    await setAppSetting('chat_title_model', 'false')
    expect(initialChatTitle('Summarise', { documentIds: [], collections: [] }).scope).toBeNull()
    await setAppSetting('chat_title_model', 'true')
  })

  test('the model\'s reply is cleaned to a bare title', () => {
    expect(cleanTitle('Title: "Self-attention in transformers."\nMore')).toBe('Self-attention in transformers')
  })

  test('words run together are no title; a single compound is', () => {
    expect(cleanTitle('solsemesterfruktosolbad')).toBe('')
    expect(cleanTitle('Badrumsrenovering')).toBe('Badrumsrenovering')
  })
})

describe('refineChatTitle', () => {
  test('replaces a weak title once, keeping its scope', async () => {
    fake = startFakeOpenAI([{ text: ['"Attention mechanisms"'] }])
    restore = envOverride({ SMALL_BASE_URL: fake.baseURL, SMALL_MODEL: 'small', SMALL_API_KEY: 't' })
    await chat('title-1', 'Paper.pdf: Compile the document into…', 'Paper.pdf')
    expect(await refineChatTitle('title-1', ME)).toBe('Paper.pdf: Attention mechanisms')
    expect(titleOf('title-1')).toEqual({ title: 'Paper.pdf: Attention mechanisms', scope: null })
    expect(await refineChatTitle('title-1', ME)).toBe('Paper.pdf: Attention mechanisms')
    expect(fake.requests.length).toBe(1)
  })

  test('a title the user renamed meanwhile is kept, and another user gets nothing', async () => {
    fake = startFakeOpenAI([{ text: ['Attention mechanisms'], delayMs: 50 }])
    restore = envOverride({ SMALL_BASE_URL: fake.baseURL, SMALL_MODEL: 'small', SMALL_API_KEY: 't' })
    await chat('title-2', 'Compile the document into…', '')
    expect(await refineChatTitle('title-2', 'someone-else')).toBeNull()
    const pending = refineChatTitle('title-2', ME)
    sqlite.run('UPDATE chat_sessions SET title = ? WHERE id = ?', ['My own title', 'title-2'])
    expect(await pending).toBe('My own title')
  })

  test('words run together keep the question\'s title', async () => {
    fake = startFakeOpenAI([{ text: ['solsemesterfruktosolbad'] }])
    restore = envOverride({ SMALL_BASE_URL: fake.baseURL, SMALL_MODEL: 'small', SMALL_API_KEY: 't' })
    await chat('title-3', 'Compile the document into…', '')
    expect(await refineChatTitle('title-3', ME)).toBe('Compile the document into…')
    expect(titleOf('title-3')).toEqual({ title: 'Compile the document into…', scope: null })
  })
})
