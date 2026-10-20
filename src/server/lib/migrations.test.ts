/** Migrations that change data rather than shape, run against rows a test can set up. */

// Must precede every other import: sets DB_PATH before lib/db.ts opens it.
import './test-support/test-env.ts'

import { describe, test, expect } from 'bun:test'
import { sqlite } from './db.ts'
import { MIGRATIONS } from './migrations.ts'

const count = (sql: string) => (sqlite.query(sql).get() as { n: number }).n

describe('migration 2: legacy orphans', () => {
  test('removes messages and space memories whose parent is gone, and nothing else', () => {
    const now = Date.now()
    sqlite.run(`INSERT INTO users (id, email, role, settings, created_at, updated_at) VALUES ('mu', 'mu@example.com', 'user', '{}', ${now}, ${now})`)
    sqlite.run(`INSERT INTO spaces (id, name, user_id, created_at, updated_at) VALUES ('msp', 'kept', 'mu', ${now}, ${now})`)
    sqlite.run(`INSERT INTO chat_sessions (id, title, user_id, created_at, updated_at) VALUES ('mchat', 'kept', 'mu', ${now}, ${now})`)
    sqlite.run(`INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('mkept', 'mchat', 'user', 'kept', ${now})`)
    sqlite.run(`INSERT INTO space_memories (id, space_id, content, created_at, updated_at) VALUES ('memkept', 'msp', 'kept', ${now}, ${now})`)
    // What a database from before foreign-key enforcement holds: children of deleted parents.
    sqlite.run('PRAGMA foreign_keys = OFF')
    sqlite.run(`INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('morphan', 'gone-chat', 'user', 'orphaned zebra', ${now})`)
    sqlite.run(`INSERT INTO space_memories (id, space_id, content, created_at, updated_at) VALUES ('memorphan', 'gone-space', 'x', ${now}, ${now})`)
    sqlite.run('PRAGMA foreign_keys = ON')
    expect(count(`SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'zebra'`)).toBe(1)

    sqlite.transaction(() => MIGRATIONS[1](sqlite))()

    expect(count('SELECT count(*) n FROM pragma_foreign_key_check')).toBe(0)
    expect(count(`SELECT count(*) n FROM messages WHERE id IN ('mkept', 'morphan')`)).toBe(1)
    expect(count(`SELECT count(*) n FROM space_memories WHERE id IN ('memkept', 'memorphan')`)).toBe(1)
    expect(count(`SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'zebra'`)).toBe(0)
  })
})
