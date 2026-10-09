/** Splitting a long note: the model's parts, each given the sources it cites. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import '../test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { startFakeOpenAI } from '../test-support/fake-openai.ts'
import { envOverride } from '../test-support/env-override.ts'

const { proposeSplit, splitSources } = await import('./note-split.ts')

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
    { text: ['```json\n[{"title":"Bees and orchards","body":"Bees pollinate orchards [1]."},{"title":"Wild bees","body":"Wild bees matter in cold springs [2]."}]\n```'] },
    { text: ['[{"title":"Only one","body":"x"}]'] },
  ])
  restoreEnv = envOverride({ CHAT_BASE_URL: model.baseURL, CHAT_API_KEY: 'test', CHAT_MODEL: 'fake' })
})
afterAll(() => { model?.stop(); restoreEnv?.() })

describe('proposeSplit', () => {
  test('returns the parts, each with only the sources it cites, and the model never sees the list', async () => {
    const parts = await proposeSplit('Bees', BODY)
    expect(parts).toEqual([
      { title: 'Bees and orchards', body: 'Bees pollinate orchards [1].\n\n---\n\n## Sources\n\n- **[1]** [Orchards](https://a.example)\n' },
      { title: 'Wild bees', body: 'Wild bees matter in cold springs [2].\n\n---\n\n## Sources\n\n- **[2]** [Wild bees](https://b.example)\n' },
    ])
    expect(JSON.stringify(model.requests[0])).not.toContain('https://a.example')
  })

  test('refuses a "split" into a single note', async () => {
    await expect(proposeSplit('Bees', BODY)).rejects.toThrow('usable split')
  })

  test('a body without a sources list is left whole', () => {
    expect(splitSources('Just text.')).toEqual({ text: 'Just text.', heading: null, lines: new Map() })
  })
})
