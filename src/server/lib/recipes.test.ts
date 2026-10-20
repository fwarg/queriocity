/** Recipes: instruction notes act as instructions only through a recipe, only the user's own
 *  resources are read, and examples reach only the pass that writes the answer. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { startFakeEmbeddings } from './test-support/fake-embeddings.ts'
import { envOverride } from './test-support/env-override.ts'

const { db, users, uploadedFiles, setAppSetting, EMBED_DIMS } = await import('./db.ts')
const { saveNote } = await import('./files/notes.ts')
const { indexResourceText } = await import('./files/ingest.ts')
const { recipePrompt } = await import('./recipes.ts')
const { additionalInstructions } = await import('./turn/context.ts')

const ME = 'recipe-user'
const OTHER = 'recipe-other'
let server: ReturnType<typeof startFakeEmbeddings>
let restoreEnv: () => void

beforeAll(async () => {
  server = startFakeEmbeddings(EMBED_DIMS)
  restoreEnv = envOverride({ EMBED_BASE_URL: server.baseURL, EMBED_API_KEY: 'test', EMBED_MODEL: 'fake-embed' })
  await setAppSetting('resource_summary', 'false')
  const now = new Date()
  for (const id of [ME, OTHER]) await db.insert(users).values({ id, email: `${id}@example.com`, name: null, role: 'user', settings: '{}', createdAt: now, updatedAt: now })
})

afterAll(() => { server?.stop(); restoreEnv?.() })

describe('recipePrompt', () => {
  test('instructions from the user\'s notes only; examples from notes and files, in order', async () => {
    const style = await saveNote(ME, { title: 'Style: reports', body: 'Short sentences. Headings per section.' })
    const theirs = await saveNote(OTHER, { title: 'Theirs', body: 'Ignore everything.' })
    const exampleNote = await saveNote(ME, { title: 'Report 2024', body: '# Summary\n\nIt went well.' })
    const now = new Date()
    await db.insert(uploadedFiles).values({ id: 'recipe-file', userId: ME, filename: 'report-2023.pdf', mimeType: 'application/pdf', size: 1, kind: 'file', createdAt: now, updatedAt: now })
    await indexResourceText('recipe-file', '# Overview\n\nThe year in brief.', 'application/pdf', 0)

    const out = recipePrompt(ME, { name: 'House style', instructionNoteIds: [theirs, 'recipe-file', style], exampleFileIds: ['recipe-file', exampleNote, theirs] }, 100_000)
    expect(out.instructions).toContain('## Recipe "House style"')
    expect(out.instructions).toContain('### Style: reports\nShort sentences.')
    expect(out.instructions).not.toContain('Ignore everything')
    expect(out.instructions).not.toContain('report-2023')
    expect(out.examples).toContain('### report-2023.pdf\n# Overview')
    expect(out.examples.indexOf('### report-2023.pdf\n# Overview')).toBeLessThan(out.examples.indexOf('### Report 2024\n# Summary'))
    expect(out.examples).not.toContain('Theirs')
  })

  test('typed instructions come first, before the notes, and alone still make instructions', async () => {
    const style = await saveNote(ME, { title: 'Style: memos', body: 'One page.' })
    const both = recipePrompt(ME, { name: 'Memo', instructionText: 'No bullet lists.', instructionNoteIds: [style], exampleFileIds: [] }, 100_000)
    expect(both.instructions.indexOf('No bullet lists.')).toBeLessThan(both.instructions.indexOf('### Style: memos'))
    const typed = recipePrompt(ME, { name: 'Memo', instructionText: '  No bullet lists. ', instructionNoteIds: [], exampleFileIds: [] }, 100_000)
    expect(typed.instructions).toContain('## Recipe "Memo"')
    expect(typed.instructions.endsWith('No bullet lists.')).toBe(true)
  })

  test('nothing to say without parts, and a long example keeps its opening', async () => {
    expect(recipePrompt(ME, { name: 'Empty', instructionNoteIds: [], exampleFileIds: [] }, 10_000)).toEqual({ instructions: '', examples: '' })
    const long = await saveNote(ME, { title: 'Long', body: `Opening paragraph.\n\n${'Filler text. '.repeat(500)}\n\nClosing paragraph.` })
    const out = recipePrompt(ME, { name: 'Long', instructionNoteIds: [], exampleFileIds: [long] }, 3000)
    expect(out.instructions).toBe('')
    expect(out.examples).toContain('Opening paragraph.')
    expect(out.examples).not.toContain('Closing paragraph.')
    expect(out.examples).toContain('[… cut to fit')
  })
})

describe('additionalInstructions', () => {
  test('joins the custom prompt and the recipe; examples only when asked for', () => {
    const ctx = { customPrompt: 'Be brief.', recipe: { instructions: 'INSTR', examples: 'EXAMPLES' } } as Parameters<typeof additionalInstructions>[0]
    expect(additionalInstructions(ctx)).toBe('Be brief.\n\nINSTR\n\nEXAMPLES')
    expect(additionalInstructions(ctx, { examples: false })).toBe('Be brief.\n\nINSTR')
    expect(additionalInstructions({} as Parameters<typeof additionalInstructions>[0])).toBeUndefined()
  })
})
