/** Splitting a long note: the model's parts, each given the sources it cites. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { startFakeOpenAI } from '../test-support/fake-openai.ts'
import { envOverride } from '../test-support/env-override.ts'

const { proposeSplit, splitSources, parseParts } = await import('./note-split.ts')

const BODY = `Bees pollinate orchards [1]. Wild bees matter in cold springs [2].

---

## Sources

- **[1]** [Orchards](https://a.example)
- **[2]** [Wild bees](https://b.example)
`
let model: ReturnType<typeof startFakeOpenAI>
let restoreEnv: () => void

beforeAll(() => {
  model = startFakeOpenAI([
    { text: ['=== OVERVIEW: Bees in orchards\ntags: bees\nHow bees pollinate orchards.\n=== Bees and orchards\ntags: Bees/Pollination, #orchards\nBees pollinate orchards [1].\n=== Wild bees\nWild bees matter in cold springs [2].'] },
    { text: ['=== Only one\nx'] },
  ])
  restoreEnv = envOverride({ CHAT_BASE_URL: model.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'fake' })
})
afterAll(() => { model?.stop(); restoreEnv?.() })

describe('proposeSplit', () => {
  test('returns the parts, each with only the sources it cites, and the model never sees the list', async () => {
    const { parts, overview } = await proposeSplit('What do bees do?', BODY, '', [{ path: 'bees', count: 3 }])
    expect(overview).toEqual({ title: 'Bees in orchards', body: 'How bees pollinate orchards.', tags: ['bees'] })
    expect(parts).toEqual([
      { title: 'Bees and orchards', tags: ['bees/pollination', 'orchards'], body: 'Bees pollinate orchards [1].\n\n---\n\n## Sources\n\n- **[1]** [Orchards](https://a.example)\n' },
      { title: 'Wild bees', body: 'Wild bees matter in cold springs [2].\n\n---\n\n## Sources\n\n- **[2]** [Wild bees](https://b.example)\n' },
    ])
    expect(JSON.stringify(model.requests[0])).not.toContain('https://a.example')
    expect(JSON.stringify(model.requests[0])).toContain('EXISTING TAGS: bees')
  })

  test('refuses a "split" into a single note', async () => {
    await expect(proposeSplit('Bees', BODY)).rejects.toThrow('usable split')
  })

  test('bodies keep backslashes, multiple lines and code; a wrapping fence and heading marks go', () => {
    const reply = '```\n=== # Regex\nMatch digits with `\\d+`.\n\nHeading\n===\nAnd $\\frac{a}{b}$.\n=== Second\nText.\n```'
    expect(parseParts(reply)).toEqual([
      { title: 'Regex', body: 'Match digits with `\\d+`.\n\nHeading\n===\nAnd $\\frac{a}{b}$.' },
      { title: 'Second', body: 'Text.' },
    ])
  })

  test('a body without a sources list is left whole', () => {
    expect(splitSources('Just text.')).toEqual({ text: 'Just text.', heading: null, lines: new Map() })
  })
})

describe('mergeParts', () => {
  test('joins texts, keeps the first title, and lists each cited source once', async () => {
    const { mergeParts } = await import('../../../shared/note-split.ts')
    const a = { title: 'Bees', tags: ['bees'], body: 'Bees [1].\n\n---\n\n## Sources\n\n- **[1]** [A](https://a.example)\n' }
    const b = { title: 'Wild', tags: ['bees', 'wild'], body: 'Wild [2] and again [1].\n\n---\n\n## Sources\n\n- **[1]** [A](https://a.example)\n- **[2]** [B](https://b.example)\n' }
    expect(mergeParts(a, b)).toEqual({
      title: 'Bees',
      tags: ['bees', 'wild'],
      body: 'Bees [1].\n\nWild [2] and again [1].\n\n---\n\n## Sources\n\n- **[1]** [A](https://a.example)\n- **[2]** [B](https://b.example)\n',
    })
  })
})

describe('hint', () => {
  test('is passed to the model ahead of the text', async () => {
    model.stop()
    model = startFakeOpenAI([{ text: ['=== One\nBees pollinate orchards [1].\n=== Two\nWild bees [2].'] }])
    process.env.CHAT_BASE_URL = model.baseURL
    await proposeSplit('Bees', BODY, 'one note per bee type')
    expect(JSON.stringify(model.requests[0])).toContain('HOW THE USER WANTS IT SPLIT')
    expect(JSON.stringify(model.requests[0])).toContain('one note per bee type')
  })
})
