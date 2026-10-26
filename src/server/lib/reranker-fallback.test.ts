/** rerankSearchResults prunes as much as it orders: what it keeps is paid for in the writer's
 *  prompt. These cover the prune when there is no reranker to do the ordering. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { envOverride } from './test-support/env-override.ts'

const { sqlite } = await import('./db.ts')
const { rerankSearchResults } = await import('./reranker.ts')

let restoreEnv: () => void
beforeAll(() => {
  restoreEnv = envOverride({ RERANK_MODEL: '' })
  sqlite.run("INSERT INTO app_settings (key, value) VALUES ('rerank_top_n', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
})
afterAll(() => {
  sqlite.run("DELETE FROM app_settings WHERE key = 'rerank_top_n'")
  restoreEnv?.()
})

const results = (n: number) => Array.from({ length: n }, (_, i) => ({ content: `result ${i}` }))

describe('rerankSearchResults without a reranker', () => {
  test('still cuts to rerank_top_n, keeping search order', async () => {
    expect(await rerankSearchResults('q', results(10))).toEqual(results(3))
  })

  test('leaves a list already within the cap alone', async () => {
    expect(await rerankSearchResults('q', results(2))).toEqual(results(2))
  })
})
