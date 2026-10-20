/** Numbered schema migrations, recorded in `PRAGMA user_version`.
 *
 *  Each entry runs once, in order, inside a transaction together with the version bump that records
 *  it — so a failed migration leaves the database at the previous version, not half-applied. Append
 *  new entries; never edit, reorder or remove one that has shipped. A new entry runs exactly once,
 *  so it needs no `IF NOT EXISTS` or try/catch, unlike the baseline.
 *
 *  Takes the connection as a parameter rather than importing db.ts, which runs `migrate` at load. */

import type { Database } from 'bun:sqlite'

/** Full-text index over message content, for chat search: word-prefix and case-insensitive
 *  (unicode-aware, so Å/å fold too). Diacritics are kept — in Swedish "år" and "ar" are different
 *  words. External-content, so the text is not stored twice; triggers keep it in step with
 *  `messages`, and a database that predates the index is backfilled once when it is created.
 *
 *  Exported for the test that guards the backfill; the baseline is the only caller in production. */
export function initMessageSearch(sqlite: Database): void {
  const exists = sqlite.query("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'").get()
  sqlite.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 0'
  )`)
  sqlite.run(`CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END`)
  sqlite.run(`CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END`)
  sqlite.run(`CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END`)
  if (!exists) sqlite.run("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
}

/** Migration 1: the schema as it stood when versioning began, from any earlier state.
 *
 *  Every database before this had `user_version` 0 and some prefix of these changes, so the baseline
 *  stays idempotent: CREATE IF NOT EXISTS, ALTERs that may already have run, guarded rebuilds. */
function baseline(sqlite: Database): void {
  // Ahead of everything below: the notes work added it, and several statements here read it.
  try { sqlite.run(`ALTER TABLE uploaded_files ADD COLUMN kind TEXT NOT NULL DEFAULT 'file'`) } catch { /* already present, or no table yet */ }

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,
      name       TEXT,
      role       TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
      settings   TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_credentials (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS invites (
      id         TEXT PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email      TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS spaces (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL DEFAULT 'space' CHECK(kind IN ('space','collection')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content    TEXT NOT NULL,
      sources    TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploaded_files (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename   TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      size       INTEGER NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'file' CHECK(kind IN ('file','note')),
      body       TEXT,
      summary    TEXT,
      topics     TEXT,
      origin     TEXT,
      derived_from TEXT REFERENCES uploaded_files(id) ON DELETE SET NULL,
      origin_session_id TEXT,
      origin_message_id TEXT,
      generated_by TEXT,
      verified_at INTEGER,
      edited_at  INTEGER,
      status     TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS space_memories (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'tool' CHECK(source IN ('tool','extraction','manual','compact')),
      session_id  TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
      always_keep INTEGER NOT NULL DEFAULT 0,
      sources     TEXT,
      checked_at  INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `)
  sqlite.run(`CREATE TABLE IF NOT EXISTS file_chunk_meta (
    chunk_id TEXT PRIMARY KEY,
    file_id  TEXT NOT NULL,
    content  TEXT NOT NULL
  )`)
  sqlite.run(`CREATE TABLE IF NOT EXISTS chat_chunk_meta (
    chunk_id   TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content    TEXT NOT NULL
  )`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_chat_chunk_meta_session ON chat_chunk_meta(session_id)`)
  sqlite.run(`CREATE TABLE IF NOT EXISTS space_files (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    file_id  TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    PRIMARY KEY (space_id, file_id)
  )`)

  // One digest per resource and model for whole-collection tasks; `text_hash` covers the text read
  // and the digest prompt, so an edit or a prompt change makes the row stale rather than wrong.
  sqlite.run(`CREATE TABLE IF NOT EXISTS resource_digests (
    file_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    model      TEXT NOT NULL,
    text_hash  TEXT NOT NULL,
    digest     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, model)
  )`)

  // What a resource says about one task (lib/files/collection-extracts.ts), per model; `key_hash`
  // covers the prompt, the task, the draft card and the text read. Pruned to the newest per resource.
  // One outline line per part of a resource (lib/files/collection-parts.ts), keyed by the part's text,
  // so a re-indexed resource gets new lines and its old ones go with the resource.
  sqlite.run(`CREATE TABLE IF NOT EXISTS resource_outlines (
    file_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    part_hash  TEXT NOT NULL,
    line       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, part_hash)
  )`)

  sqlite.run(`CREATE TABLE IF NOT EXISTS resource_extracts (
    file_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    model      TEXT NOT NULL,
    key_hash   TEXT NOT NULL,
    extract    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, model, key_hash)
  )`)

  // Migration: drop old memory_chunks table (replaced by chat_chunks)
  sqlite.run('DROP TABLE IF EXISTS memory_chunks')

  // Migration: add space_id column if it doesn't exist yet
  try {
    sqlite.run(`ALTER TABLE chat_sessions ADD COLUMN space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL`)
  } catch {}

  // Migration: add graduated column for monitor session graduation
  try {
    sqlite.run(`ALTER TABLE chat_sessions ADD COLUMN graduated INTEGER NOT NULL DEFAULT 0`)
  } catch {}

  // Migration: add offline (locked) flag for spaces. Defaults to 0, so every existing space keeps
  // its web access — locking is always an explicit choice.
  try {
    sqlite.run(`ALTER TABLE spaces ADD COLUMN offline INTEGER NOT NULL DEFAULT 0`)
  } catch {}

  // Migration: add 'compact' to space_memories source CHECK constraint.
  // Guarded on the constraint actually being stale — the rebuild used to run on every boot
  // (CREATE IF NOT EXISTS → INSERT SELECT * → DROP → RENAME round-trips the table each start),
  // which is both wasteful and unsafe once the table gains columns the v2 definition lacks:
  // `SELECT *` would quietly copy them into the wrong slots or drop them.
  const memoriesSql = (sqlite.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='space_memories'"
  ).get() as { sql: string } | null)?.sql ?? ''
  if (memoriesSql && !memoriesSql.includes("'compact'")) {
    sqlite.run(`DROP TABLE IF EXISTS space_memories_v2`)
    sqlite.run(`CREATE TABLE space_memories_v2 (
      id         TEXT PRIMARY KEY,
      space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'tool' CHECK(source IN ('tool','extraction','manual','compact')),
      session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    // Explicit column list, not SELECT *, so the copy cannot silently misalign.
    sqlite.run(`INSERT OR IGNORE INTO space_memories_v2
      (id, space_id, content, source, session_id, created_at, updated_at)
      SELECT id, space_id, content, source, session_id, created_at, updated_at FROM space_memories`)
    sqlite.run(`DROP TABLE space_memories`)
    sqlite.run(`ALTER TABLE space_memories_v2 RENAME TO space_memories`)
    console.log('[db] Migrated space_memories to allow source=compact')
  }
  // Leftover from when the rebuild above ran unconditionally.
  sqlite.run(`DROP TABLE IF EXISTS space_memories_v2`)

  // The rebuild block above copies only the seven original columns; every column added since —
  // always_keep, sources, checked_at — is (re-)added by the ALTERs below, which no-op once applied.
  // Migration: per-memory "always keep" flag (see spaceMemories schema).
  try {
    sqlite.run(`ALTER TABLE space_memories ADD COLUMN always_keep INTEGER NOT NULL DEFAULT 0`)
  } catch {}

  // Migration: space-memory provenance (see spaceMemories schema). Both nullable and best-effort —
  // a memory with no cited web sources or no verification timestamp is the normal case.
  try { sqlite.run(`ALTER TABLE space_memories ADD COLUMN sources TEXT`) } catch {}
  try { sqlite.run(`ALTER TABLE space_memories ADD COLUMN checked_at INTEGER`) } catch {}

  sqlite.run(`CREATE TABLE IF NOT EXISTS user_memories (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('tool','manual')),
    always_keep INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_user_memories_user_id ON user_memories(user_id)`)

  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_spaces_user_id ON spaces(user_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_space_id ON chat_sessions(space_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_uploaded_files_user_id ON uploaded_files(user_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_file_chunk_meta_file_id ON file_chunk_meta(file_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_space_memories_space_id ON space_memories(space_id)`)
  // Redundant with the (space_id, file_id) primary key, which already serves space_id lookups.
  sqlite.run('DROP INDEX IF EXISTS idx_space_files_space_id')
  sqlite.run(`CREATE TABLE IF NOT EXISTS custom_templates (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT,
    prompt_text    TEXT NOT NULL,
    suggested_mode TEXT NOT NULL DEFAULT 'balanced',
    instruction_note_ids TEXT,
    instruction_text TEXT,
    example_file_ids TEXT,
    settings       TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  )`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_custom_templates_user_id ON custom_templates(user_id)`)

  sqlite.run(`CREATE TABLE IF NOT EXISTS monitors (
    id               TEXT PRIMARY KEY,
    user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    prompt_text      TEXT NOT NULL,
    focus_mode       TEXT NOT NULL DEFAULT 'balanced',
    interval_minutes INTEGER NOT NULL,
    keep_count       INTEGER NOT NULL DEFAULT 3,
    is_global        INTEGER NOT NULL DEFAULT 0,
    space_id         TEXT REFERENCES spaces(id) ON DELETE SET NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    next_run_at      INTEGER,
    last_run_at      INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  )`)
  sqlite.run(`CREATE TABLE IF NOT EXISTS monitor_subscriptions (
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, user_id)
  )`)
  sqlite.run(`CREATE TABLE IF NOT EXISTS monitor_runs (
    id         TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    run_at     INTEGER NOT NULL
  )`)
  // Calls per search provider per UTC month, for the monthly quotas in search/policy.ts.
  sqlite.run(`CREATE TABLE IF NOT EXISTS search_usage (
    provider TEXT NOT NULL,
    month    TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, month)
  )`)
  // Cloud LLM providers a user may use, with a monthly budget in the provider's currency.
  sqlite.run(`CREATE TABLE IF NOT EXISTS user_llm_access (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id    TEXT NOT NULL,
    monthly_budget REAL NOT NULL,
    PRIMARY KEY (user_id, provider_id)
  )`)
  // Cloud LLM spend per user, provider and UTC month. No foreign key: a deleted user's spend
  // still counts towards the provider's monthly cap.
  sqlite.run(`CREATE TABLE IF NOT EXISTS llm_usage (
    user_id       TEXT NOT NULL,
    provider_id   TEXT NOT NULL,
    month         TEXT NOT NULL,
    cost          REAL NOT NULL DEFAULT 0,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    requests      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, provider_id, month)
  )`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_monitors_user_id ON monitors(user_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_monitors_next_run ON monitors(next_run_at)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_monitor_runs_monitor_user ON monitor_runs(monitor_id, user_id)`)
  try { sqlite.run('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0') } catch {}
  try { sqlite.run('ALTER TABLE users ADD COLUMN cloud_enabled INTEGER NOT NULL DEFAULT 0') } catch {}
  try { sqlite.run('ALTER TABLE messages ADD COLUMN model TEXT') } catch {}
  try { sqlite.run('ALTER TABLE auth_credentials ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0') } catch {}
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN preferred_hour INTEGER') } catch {}
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN timezone TEXT') } catch {}
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN feed_sources TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN content_hash TEXT') } catch {}
  // `kind` is added at the top of the baseline — statements here read it.
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN body TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN summary TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN topics TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN updated_at INTEGER') } catch {}
  // No REFERENCES clause: SQLite's ALTER TABLE ADD COLUMN rejects one with a non-null default and
  // cannot add the constraint to an existing table at all. New databases get it from the CREATE
  // above; on an upgraded one the column is a plain id, and routes/files.ts nulls it on delete.
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN derived_from TEXT') } catch {}
  try { sqlite.run(`ALTER TABLE spaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'space'`) } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN origin TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN origin_session_id TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN origin_message_id TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN generated_by TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN verified_at INTEGER') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN edited_at INTEGER') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN status TEXT') } catch {}
  try { sqlite.run('ALTER TABLE custom_templates ADD COLUMN instruction_note_ids TEXT') } catch {}
  // Lookups by the second PK column, or by columns added above: without these each is a table scan.
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_space_files_file_id ON space_files(file_id)')
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_monitor_runs_session_id ON monitor_runs(session_id)')
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_uploaded_files_derived_from ON uploaded_files(derived_from)')
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_uploaded_files_origin_session ON uploaded_files(user_id, origin_session_id)')
  initMessageSearch(sqlite)
  try { sqlite.run('ALTER TABLE custom_templates ADD COLUMN instruction_text TEXT') } catch {}
  try { sqlite.run('ALTER TABLE custom_templates ADD COLUMN example_file_ids TEXT') } catch {}
  try { sqlite.run('ALTER TABLE custom_templates ADD COLUMN settings TEXT') } catch {}
  sqlite.run(`CREATE TABLE IF NOT EXISTS tags (
    id      TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path    TEXT NOT NULL,
    UNIQUE (user_id, path)
  )`)
  sqlite.run(`CREATE TABLE IF NOT EXISTS resource_tags (
    resource_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (resource_id, tag_id)
  )`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_resource_tags_tag ON resource_tags(tag_id)`)
  sqlite.run(`CREATE TABLE IF NOT EXISTS resource_links (
    src_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    dst_id    TEXT REFERENCES uploaded_files(id) ON DELETE SET NULL,
    dst_title TEXT NOT NULL
  )`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_resource_links_src ON resource_links(src_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_resource_links_dst ON resource_links(dst_id)`)
  // Names the small model gave topic-map clusters, keyed by a hash of the members, so reopening
  // the map does not re-name what has not changed.
  sqlite.run(`CREATE TABLE IF NOT EXISTS topic_names (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    name    TEXT NOT NULL,
    tag     TEXT,
    PRIMARY KEY (user_id, key)
  )`)
  // Earlier versions of a note, kept when an agent rewrites one (lib/files/agent-notes.ts) and when
  // a version is restored, so either can be undone. Newest few per note.
  sqlite.run(`CREATE TABLE IF NOT EXISTS note_revisions (
    id         TEXT PRIMARY KEY,
    note_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    actor      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_note_revisions_note ON note_revisions(note_id, created_at)`)
  // The documents an agent's note cites: what marks a document as having had notes saved from it.
  sqlite.run(`CREATE TABLE IF NOT EXISTS agent_note_documents (
    note_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, file_id)
  )`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_agent_note_documents_file ON agent_note_documents(file_id)`)
  // Suggested links the user turned down, so the same pair is not proposed again.
  sqlite.run(`CREATE TABLE IF NOT EXISTS link_dismissals (
    src_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    dst_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    PRIMARY KEY (src_id, dst_id)
  )`)
  try { sqlite.run('ALTER TABLE messages ADD COLUMN file_sources TEXT') } catch {}
  try { sqlite.run('ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0') } catch {}
  try { sqlite.run('ALTER TABLE chat_sessions ADD COLUMN context_report TEXT') } catch {}
  try { sqlite.run('ALTER TABLE chat_sessions ADD COLUMN history_summary TEXT') } catch {}
  try { sqlite.run('ALTER TABLE chat_sessions ADD COLUMN locked INTEGER NOT NULL DEFAULT 0') } catch {}
  try { sqlite.run('ALTER TABLE chat_sessions ADD COLUMN locked_by TEXT') } catch {}
  try { sqlite.run('ALTER TABLE chat_sessions ADD COLUMN auto_title_scope TEXT') } catch {}
  // Briefly named `locked`, before content and chats got a word each; renamed where it exists.
  try { sqlite.run('ALTER TABLE uploaded_files RENAME COLUMN locked TO confidential') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN confidential INTEGER NOT NULL DEFAULT 0') } catch {}
}

/** Migration 2: rows orphaned before foreign keys were enforced (2026-04-26) — messages of deleted
 *  chats and memories of deleted spaces. Nothing shows them, but the messages were still searchable
 *  through the full-text index. Their vectors go with the startup sweep in vector-cleanup.ts. */
function deleteLegacyOrphans(sqlite: Database): void {
  // SQLite's changes(), not Bun's `.changes`: the latter also counts the writes the full-text
  // index's delete trigger makes to its shadow tables, so it reported several times the real number.
  const deleted = (sql: string) => {
    sqlite.run(sql)
    return (sqlite.query('SELECT changes() AS n').get() as { n: number }).n
  }
  const orphanedMessages = deleted('DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM chat_sessions)')
  const orphanedMemories = deleted('DELETE FROM space_memories WHERE space_id NOT IN (SELECT id FROM spaces)')
  console.log(`[db] removed ${orphanedMessages} orphaned message(s) and ${orphanedMemories} orphaned space memory row(s)`)
}

export const MIGRATIONS: ReadonlyArray<(sqlite: Database) => void> = [baseline, deleteLegacyOrphans]

/** Brings the database up to the latest migration. */
export function migrate(sqlite: Database): void {
  const { user_version: current } = sqlite.query('PRAGMA user_version').get() as { user_version: number }
  for (let version = current; version < MIGRATIONS.length; version++) {
    sqlite.transaction(() => {
      MIGRATIONS[version](sqlite)
      sqlite.run(`PRAGMA user_version = ${version + 1}`)
    })()
    console.log(`[db] schema migrated to version ${version + 1}`)
  }
}
