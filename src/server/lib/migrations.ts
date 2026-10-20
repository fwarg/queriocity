/** The schema and its migrations, versioned in `PRAGMA user_version`.
 *
 *  A new database gets SCHEMA and starts at BASELINE_VERSION. Every later change is appended to
 *  MIGRATIONS and runs once, inside a transaction together with the version bump that records it —
 *  so a failed migration leaves the database at the previous version, not half-applied. Never edit,
 *  reorder or remove an entry that has shipped; SCHEMA, by contrast, is the baseline and stays as is.
 *
 *  The vector tables are not here: their dimension follows EMBED_DIMENSIONS, which can change between
 *  starts, so db.ts checks them on every start instead.
 *
 *  Takes the connection as a parameter rather than importing db.ts, which runs `migrate` at load. */

import type { Database } from 'bun:sqlite'

/** The version a new database starts at, and the one scripts/migrate-legacy-db.ts converts to.
 *  0 was the unversioned era, whose databases drifted with the code that created them (missing
 *  foreign keys, columns added in whatever order); 1 and 2 were interim. Below this, a database is
 *  refused rather than guessed at. */
export const BASELINE_VERSION = 3

const TABLES = `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT,
    role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    settings      TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    -- Bumped on delete, role change and password change: see lib/auth.ts.
    token_version INTEGER NOT NULL DEFAULT 0,
    cloud_enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE auth_credentials (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email                TEXT NOT NULL UNIQUE,
    password_hash        TEXT NOT NULL,
    active               INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE invites (
    id         TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  CREATE TABLE spaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'space' CHECK(kind IN ('space','collection')),
    -- Locked: no web access for any chat in the space. Locking is always an explicit choice.
    offline    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE chat_sessions (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id         TEXT REFERENCES spaces(id) ON DELETE SET NULL,
    graduated        INTEGER NOT NULL DEFAULT 0,
    context_report   TEXT,
    history_summary  TEXT,
    locked           INTEGER NOT NULL DEFAULT 0,
    locked_by        TEXT,
    auto_title_scope TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content      TEXT NOT NULL,
    sources      TEXT,
    file_sources TEXT,
    model        TEXT,
    pinned       INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE uploaded_files (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename          TEXT NOT NULL,
    mime_type         TEXT NOT NULL,
    size              INTEGER NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'file' CHECK(kind IN ('file','note')),
    body              TEXT,
    summary           TEXT,
    topics            TEXT,
    origin            TEXT,
    derived_from      TEXT REFERENCES uploaded_files(id) ON DELETE SET NULL,
    origin_session_id TEXT,
    origin_message_id TEXT,
    generated_by      TEXT,
    verified_at       INTEGER,
    edited_at         INTEGER,
    status            TEXT,
    content_hash      TEXT,
    confidential      INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER
  );
  CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE space_memories (
    id          TEXT PRIMARY KEY,
    space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'tool' CHECK(source IN ('tool','extraction','manual','compact')),
    session_id  TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
    always_keep INTEGER NOT NULL DEFAULT 0,
    -- Provenance, both best-effort: a memory with no web sources or no check is the normal case.
    sources     TEXT,
    checked_at  INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE user_memories (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('tool','manual')),
    always_keep INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- The text behind the vectors, verbatim: a dimension change re-embeds from here, never re-chunks.
  CREATE TABLE file_chunk_meta (
    chunk_id TEXT PRIMARY KEY,
    file_id  TEXT NOT NULL,
    content  TEXT NOT NULL
  );
  CREATE TABLE chat_chunk_meta (
    chunk_id   TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content    TEXT NOT NULL
  );

  CREATE TABLE space_files (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    file_id  TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    PRIMARY KEY (space_id, file_id)
  );
  -- One digest per resource and model for whole-collection tasks; text_hash covers the text read and
  -- the digest prompt, so an edit or a prompt change makes the row stale rather than wrong.
  CREATE TABLE resource_digests (
    file_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    model      TEXT NOT NULL,
    text_hash  TEXT NOT NULL,
    digest     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, model)
  );
  -- One outline line per part of a resource (lib/files/collection-parts.ts), keyed by the part's
  -- text, so a re-indexed resource gets new lines and its old ones go with the resource.
  CREATE TABLE resource_outlines (
    file_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    part_hash  TEXT NOT NULL,
    line       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, part_hash)
  );
  -- What a resource says about one task (lib/files/collection-extracts.ts), per model; key_hash covers
  -- the prompt, the task, the draft card and the text read. Pruned to the newest per resource.
  CREATE TABLE resource_extracts (
    file_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    model      TEXT NOT NULL,
    key_hash   TEXT NOT NULL,
    extract    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, model, key_hash)
  );
  CREATE TABLE tags (
    id      TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path    TEXT NOT NULL,
    UNIQUE (user_id, path)
  );
  CREATE TABLE resource_tags (
    resource_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (resource_id, tag_id)
  );
  CREATE TABLE resource_links (
    src_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    dst_id    TEXT REFERENCES uploaded_files(id) ON DELETE SET NULL,
    dst_title TEXT NOT NULL
  );
  -- Names the small model gave topic-map clusters, keyed by a hash of the members, so reopening the
  -- map does not re-name what has not changed.
  CREATE TABLE topic_names (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    name    TEXT NOT NULL,
    tag     TEXT,
    PRIMARY KEY (user_id, key)
  );
  -- Earlier versions of a note, kept when an agent rewrites one (lib/files/agent-notes.ts) and when a
  -- version is restored, so either can be undone. Newest few per note.
  CREATE TABLE note_revisions (
    id         TEXT PRIMARY KEY,
    note_id    TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    actor      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- The documents an agent's note cites: what marks a document as having had notes saved from it.
  CREATE TABLE agent_note_documents (
    note_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, file_id)
  );
  -- Suggested links the user turned down, so the same pair is not proposed again.
  CREATE TABLE link_dismissals (
    src_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    dst_id TEXT NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
    PRIMARY KEY (src_id, dst_id)
  );
  CREATE TABLE custom_templates (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    description          TEXT,
    prompt_text          TEXT NOT NULL,
    suggested_mode       TEXT NOT NULL DEFAULT 'balanced',
    instruction_note_ids TEXT,
    instruction_text     TEXT,
    example_file_ids     TEXT,
    settings             TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );

  CREATE TABLE monitors (
    id               TEXT PRIMARY KEY,
    user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    prompt_text      TEXT NOT NULL,
    focus_mode       TEXT NOT NULL DEFAULT 'balanced',
    interval_minutes INTEGER NOT NULL,
    preferred_hour   INTEGER,
    timezone         TEXT,
    feed_sources     TEXT,
    keep_count       INTEGER NOT NULL DEFAULT 3,
    is_global        INTEGER NOT NULL DEFAULT 0,
    space_id         TEXT REFERENCES spaces(id) ON DELETE SET NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    next_run_at      INTEGER,
    last_run_at      INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE TABLE monitor_subscriptions (
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, user_id)
  );
  CREATE TABLE monitor_runs (
    id         TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    run_at     INTEGER NOT NULL
  );

  -- Calls per search provider per UTC month, for the monthly quotas in search/policy.ts.
  CREATE TABLE search_usage (
    provider TEXT NOT NULL,
    month    TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, month)
  );
  -- Cloud LLM providers a user may use, with a monthly budget in the provider's currency.
  CREATE TABLE user_llm_access (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id    TEXT NOT NULL,
    monthly_budget REAL NOT NULL,
    PRIMARY KEY (user_id, provider_id)
  );
  -- Cloud LLM spend per user, provider and UTC month. No foreign key: a deleted user's spend still
  -- counts towards the provider's monthly cap.
  CREATE TABLE llm_usage (
    user_id       TEXT NOT NULL,
    provider_id   TEXT NOT NULL,
    month         TEXT NOT NULL,
    cost          REAL NOT NULL DEFAULT 0,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    requests      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, provider_id, month)
  );

  -- Full-text index over message content, for chat search: word-prefix and case-insensitive
  -- (unicode-aware, so Å/å fold too). Diacritics are kept — in Swedish "år" and "ar" are different
  -- words. External-content, so the text is not stored twice; the triggers keep it in step.
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 0'
  );
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
`

/** Every index, kept apart from the tables so the list reads at a glance. */
const INDEXES = `
  CREATE INDEX idx_spaces_user_id ON spaces(user_id);
  CREATE INDEX idx_chat_sessions_user_id ON chat_sessions(user_id);
  CREATE INDEX idx_chat_sessions_space_id ON chat_sessions(space_id);
  CREATE INDEX idx_messages_session_id ON messages(session_id);
  CREATE INDEX idx_uploaded_files_user_id ON uploaded_files(user_id);
  CREATE INDEX idx_uploaded_files_derived_from ON uploaded_files(derived_from);
  CREATE INDEX idx_uploaded_files_origin_session ON uploaded_files(user_id, origin_session_id);
  CREATE INDEX idx_space_memories_space_id ON space_memories(space_id);
  CREATE INDEX idx_user_memories_user_id ON user_memories(user_id);
  CREATE INDEX idx_file_chunk_meta_file_id ON file_chunk_meta(file_id);
  CREATE INDEX idx_chat_chunk_meta_session ON chat_chunk_meta(session_id);
  CREATE INDEX idx_space_files_file_id ON space_files(file_id);
  CREATE INDEX idx_resource_tags_tag ON resource_tags(tag_id);
  CREATE INDEX idx_resource_links_src ON resource_links(src_id);
  CREATE INDEX idx_resource_links_dst ON resource_links(dst_id);
  CREATE INDEX idx_note_revisions_note ON note_revisions(note_id, created_at);
  CREATE INDEX idx_agent_note_documents_file ON agent_note_documents(file_id);
  CREATE INDEX idx_custom_templates_user_id ON custom_templates(user_id);
  CREATE INDEX idx_monitors_user_id ON monitors(user_id);
  CREATE INDEX idx_monitors_next_run ON monitors(next_run_at);
  CREATE INDEX idx_monitor_runs_monitor_user ON monitor_runs(monitor_id, user_id);
  CREATE INDEX idx_monitor_runs_session_id ON monitor_runs(session_id);
`

/** The baseline: what a new database is created with, and what the legacy script converts to. */
export const SCHEMA = TABLES + INDEXES

/** Changes after the baseline: entry i takes a database from BASELINE_VERSION + i to the next. */
export const MIGRATIONS: ReadonlyArray<(sqlite: Database) => void> = []

export const LATEST_VERSION = BASELINE_VERSION + MIGRATIONS.length

const versionOf = (sqlite: Database) =>
  (sqlite.query('PRAGMA user_version').get() as { user_version: number }).user_version

const isEmpty = (sqlite: Database) =>
  !sqlite.query("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()

/** Creates the schema in an empty database, or brings an existing one up to the latest version. */
export function migrate(sqlite: Database): void {
  if (isEmpty(sqlite)) {
    sqlite.transaction(() => {
      sqlite.run(SCHEMA)
      sqlite.run(`PRAGMA user_version = ${BASELINE_VERSION}`)
    })()
    console.log(`[db] created schema at version ${BASELINE_VERSION}`)
  }
  const current = versionOf(sqlite)
  if (current < BASELINE_VERSION) {
    throw new Error(`[db] schema version ${current} predates the baseline (${BASELINE_VERSION}). `
      + 'Convert the database once, with the server stopped: bun run scripts/migrate-legacy-db.ts <old.db> <new.db>')
  }
  if (current > LATEST_VERSION) {
    throw new Error(`[db] schema version ${current} is newer than this code knows (${LATEST_VERSION}) — refusing to run an older build against it`)
  }
  for (let version = current; version < LATEST_VERSION; version++) {
    sqlite.transaction(() => {
      MIGRATIONS[version - BASELINE_VERSION](sqlite)
      sqlite.run(`PRAGMA user_version = ${version + 1}`)
    })()
    console.log(`[db] schema migrated to version ${version + 1}`)
  }
}
