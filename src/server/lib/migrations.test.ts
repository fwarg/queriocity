/** What `migrate` does with each kind of database it can be handed at startup. */

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrate, BASELINE_VERSION, LATEST_VERSION } from './migrations.ts'

const versionOf = (d: Database) => (d.query('PRAGMA user_version').get() as { user_version: number }).user_version

describe('migrate', () => {
  test('creates the schema in an empty database, at the latest version', () => {
    const d = new Database(':memory:')
    migrate(d)
    expect(versionOf(d)).toBe(LATEST_VERSION)
    expect(d.query("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'").get()).not.toBeNull()
    // A second start changes nothing.
    migrate(d)
    expect(versionOf(d)).toBe(LATEST_VERSION)
  })

  test('refuses a database from before the baseline, naming the script that converts it', () => {
    const d = new Database(':memory:')
    d.run('CREATE TABLE users (id TEXT PRIMARY KEY)')
    expect(() => migrate(d)).toThrow('scripts/migrate-legacy-db.ts')
    d.run(`PRAGMA user_version = ${BASELINE_VERSION - 1}`)
    expect(() => migrate(d)).toThrow('predates the baseline')
  })

  test('refuses a database newer than the code', () => {
    const d = new Database(':memory:')
    migrate(d)
    d.run(`PRAGMA user_version = ${LATEST_VERSION + 1}`)
    expect(() => migrate(d)).toThrow('newer than this code')
  })
})
