import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq, sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

const DB_PATH = process.env.DB_PATH ?? 'queriocity.db'

const sqlite = new Database(DB_PATH)
sqlite.loadExtension(sqliteVec.getLoadablePath())
sqlite.run('PRAGMA foreign_keys = ON')
// WAL lets background work (monitor runs, nightly dream compaction) write while requests
// read, instead of blocking them; busy_timeout absorbs the brief contention that remains.
// `sqlite3 .backup` — the method in the README — stays correct under WAL.
sqlite.run('PRAGMA journal_mode = WAL')
sqlite.run('PRAGMA synchronous = NORMAL')
sqlite.run('PRAGMA busy_timeout = 5000')

export const db = drizzle(sqlite)

// --- Schema ---

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  settings: text('settings').notNull().default('{}'),
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const authCredentials = sqliteTable('auth_credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  /** Set when an admin issues a temporary password; the user is prompted to replace it. */
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
})

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  email: text('email'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/** Named groupings, in two kinds.
 *
 *  A **space** organises chats: it accumulates memory, indexes its conversations, can be locked, and
 *  may hold tagged resources. A **collection** organises resources only — no chats, no memory, no
 *  monitors, no lock. One table rather than two because everything a collection needs already exists
 *  here: `space_files` tagging, ownership checks, delete-cascade, the Resources filter chips, and
 *  `searchSpaceFiles()`, which works on a collection id verbatim. */
export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** `'space'` is the default so every pre-existing row is already correct without a backfill. */
  kind: text('kind', { enum: ['space', 'collection'] }).notNull().default('space'),
  /** Locked: chats here get no web search, no URL fetching and no image generation.
   *
   *  A capability control, not a detection one — the tools are absent rather than screened, so
   *  there is nothing for the egress guard to get wrong. Read from here on every chat request and
   *  never from the client. Effectively one-way once the space holds anything; see routes/spaces.ts
   *  for why, and for the three other ways a chat could otherwise escape a locked space. */
  offline: integer('offline', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  spaceId: text('space_id').references(() => spaces.id, { onDelete: 'set null' }),
  graduated: integer('graduated').notNull().default(0),
})

export const spaceMemories = sqliteTable('space_memories', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  source: text('source', { enum: ['tool', 'extraction', 'manual', 'compact'] }).notNull().default('tool'),
  sessionId: text('session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
  /** User-set: always injected regardless of relevance, and never merged away by compaction. */
  alwaysKeep: integer('always_keep', { mode: 'boolean' }).notNull().default(false),
  /** Web sources the memory was extracted from, for the panel and a future verify pass. Never
   *  injected into the prompt. Null for hand-typed, tool-less, and compacted/dreamed memories. */
  sources: text('sources', { mode: 'json' }).$type<{ url: string; title: string }[]>(),
  /** Unix seconds when the cited sources were last seen to support the memory. Null = unverified.
   *  Plain integer, not a timestamp column, to keep the JSON wire value unambiguous. */
  checkedAt: integer('checked_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

/** Facts about the user that apply in any chat, space or not. Deliberately has no `sessionId`:
 *  the FK-timing bug that silently dropped the first memory of a new chat lives in that column,
 *  and provenance is not needed for a set this small and this hand-curated. */
export const userMemories = sqliteTable('user_memories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  source: text('source', { enum: ['tool', 'manual'] }).notNull().default('manual'),
  alwaysKeep: integer('always_keep', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  sources: text('sources'),
  fileSources: text('file_sources'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

/** The resource library: uploaded files, ingested URLs, and notes.
 *
 *  A note is a row here rather than a table of its own, so tagging to spaces, tagged-file RAG,
 *  `uploads_search`, the per-resource context checkboxes and delete-cascade all apply to it
 *  unchanged. Its title lives in `filename` — that column is what every citation and retrieval
 *  label already reads. */
export const uploadedFiles = sqliteTable('uploaded_files', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  contentHash: text('content_hash'),
  kind: text('kind', { enum: ['file', 'note'] }).notNull().default('file'),
  /** A note's markdown source. Null for files, whose text survives only as chunks. */
  body: text('body'),
  /** One-line summary and a few topics, generated by the small model at ingest. Both null when the
   *  call failed or the `resource_summary` setting is off — neither is required by anything. */
  summary: text('summary'),
  topics: text('topics'),
  /** Where this came from: the full URL for an ingested page, the original filename for an upload,
   *  null for a note. Set once at ingest and never edited — `filename` is a *title* the user may
   *  rename, so without this the address of an ingested page was recorded nowhere at all, and even
   *  unrenamed it survived only as the lossy label `urlLabel()` derives (no scheme, 120 chars). */
  origin: text('origin'),
  /** The resource a transform produced this note from. Nulled rather than cascaded when that
   *  resource is deleted: the note is the user's own text and outlives what prompted it. The same
   *  provenance is also written into the note's first line, which is what carries it into retrieval
   *  and export — this column exists so the panel can link back. */
  derivedFrom: text('derived_from').references((): AnySQLiteColumn => uploadedFiles.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

export const spaceFiles = sqliteTable('space_files', {
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  fileId: text('file_id').notNull().references(() => uploadedFiles.id, { onDelete: 'cascade' }),
}, (t) => ({ pk: primaryKey({ columns: [t.spaceId, t.fileId] }) }))

export const customTemplates = sqliteTable('custom_templates', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  promptText: text('prompt_text').notNull(),
  suggestedMode: text('suggested_mode').notNull().default('balanced'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const monitors = sqliteTable('monitors', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  promptText: text('prompt_text').notNull(),
  focusMode: text('focus_mode').notNull().default('balanced'),
  intervalMinutes: integer('interval_minutes').notNull(),
  keepCount: integer('keep_count').notNull().default(3),
  isGlobal: integer('is_global', { mode: 'boolean' }).notNull().default(false),
  spaceId: text('space_id').references(() => spaces.id, { onDelete: 'set null' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  preferredHour: integer('preferred_hour'),
  timezone: text('timezone'),
  feedSources: text('feed_sources'),
  nextRunAt: integer('next_run_at', { mode: 'timestamp' }),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const monitorSubscriptions = sqliteTable('monitor_subscriptions', {
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, t => ({ pk: primaryKey({ columns: [t.monitorId, t.userId] }) }))

export const monitorRuns = sqliteTable('monitor_runs', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  runAt: integer('run_at', { mode: 'timestamp' }).notNull(),
})

// --- Init ---

export const EMBED_DIMS = parseInt(process.env.EMBED_DIMENSIONS ?? '1536')

/** True when a vec0 table exists at a dimension other than the one now configured. */
function dimensionChanged(table: string): boolean {
  const existing = sqlite.query(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`
  ).get() as { sql: string } | null
  return !!existing && !existing.sql.includes(`FLOAT[${EMBED_DIMS}]`)
}

/** Drops the file vectors so the table can be recreated at the new dimension. Nothing else goes.
 *
 *  A vector is derived data; the text it was built from is not. `file_chunk_meta.content` holds
 *  every chunk verbatim, and chunk boundaries depend on the mime type rather than the model — so a
 *  dimension change needs re-embedding, never re-chunking, and never the loss of a resource. This
 *  used to delete every uploaded file, which also took its space tags and any note derived from it.
 *
 *  Exported for the test that guards that; initSchema is the only caller in production. */
export function resetFileEmbeddings(): void {
  sqlite.run('DROP TABLE IF EXISTS file_chunks')
}

function initSchema() {
  // Ahead of everything below: the notes work added it, and several statements here read it.
  try { sqlite.run(`ALTER TABLE uploaded_files ADD COLUMN kind TEXT NOT NULL DEFAULT 'file'`) } catch { /* already present, or no table yet */ }

  // Recreate the vector tables if the embedding dimension changed. Both keep their `*_chunk_meta`
  // rows, so reembedMissingVectors() at startup restores them from text already on disk — which is
  // why neither is gated behind ALLOW_EMBED_RESET any more: there is nothing left to destroy.
  if (dimensionChanged('file_chunks')) {
    console.log(`[db] Embedding dimension changed → recreating file_chunks (${EMBED_DIMS} dims), resources kept for re-embedding`)
    resetFileEmbeddings()
  }

  if (dimensionChanged('chat_chunks')) {
    console.log(`[db] Embedding dimension changed → recreating chat_chunks (${EMBED_DIMS} dims), history kept for re-embedding`)
    sqlite.run('DROP TABLE IF EXISTS chat_chunks')
  }

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
  sqlite.run(`CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks USING vec0(
    chunk_id TEXT PRIMARY KEY,
    embedding FLOAT[${EMBED_DIMS}]
  )`)
  sqlite.run(`CREATE TABLE IF NOT EXISTS file_chunk_meta (
    chunk_id TEXT PRIMARY KEY,
    file_id  TEXT NOT NULL,
    content  TEXT NOT NULL
  )`)
  sqlite.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chat_chunks USING vec0(
    chunk_id TEXT PRIMARY KEY,
    embedding FLOAT[${EMBED_DIMS}]
  )`)
  // One vector per memory, keyed by the memory's own id — memories are single short facts, so
  // unlike chat/file content they need no chunking and no meta table; the text stays in
  // space_memories. Purely derived data: on a dimension change we drop and re-embed rather than
  // demanding a confirmation, because nothing is lost. buildMemoryBlock backfills lazily — the
  // same principle the file and chat vectors now follow, via reembedMissingVectors at startup.
  const existingMemVec = sqlite.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_embeddings'"
  ).get() as { sql: string } | null
  if (existingMemVec && !existingMemVec.sql.includes(`FLOAT[${EMBED_DIMS}]`)) {
    console.log(`[db] Embedding dimension changed → recreating memory_embeddings (${EMBED_DIMS} dims)`)
    sqlite.run('DROP TABLE IF EXISTS memory_embeddings')
  }
  sqlite.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
    memory_id TEXT PRIMARY KEY,
    embedding FLOAT[${EMBED_DIMS}]
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
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_space_files_space_id ON space_files(space_id)`)
  sqlite.run(`CREATE TABLE IF NOT EXISTS custom_templates (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT,
    prompt_text    TEXT NOT NULL,
    suggested_mode TEXT NOT NULL DEFAULT 'balanced',
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
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_monitors_user_id ON monitors(user_id)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_monitors_next_run ON monitors(next_run_at)`)
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_monitor_runs_monitor_user ON monitor_runs(monitor_id, user_id)`)
  try { sqlite.run('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0') } catch {}
  try { sqlite.run('ALTER TABLE auth_credentials ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0') } catch {}
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN preferred_hour INTEGER') } catch {}
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN timezone TEXT') } catch {}
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN feed_sources TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN content_hash TEXT') } catch {}
  // `kind` is added at the top of initSchema — the reset branch there depends on it.
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
  try { sqlite.run('ALTER TABLE messages ADD COLUMN file_sources TEXT') } catch {}
  // Migrate: backfill timezone from owner's settings for personal monitors that have none
  try {
    sqlite.run(`
      UPDATE monitors SET timezone = (
        SELECT json_extract(u.settings, '$.timezone')
        FROM users u WHERE u.id = monitors.user_id
      )
      WHERE timezone IS NULL AND user_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = monitors.user_id
                    AND json_extract(u.settings, '$.timezone') IS NOT NULL)
    `)
  } catch {}
}

initSchema()

export { sqlite }

/** Safely parse a user's settings JSON, returning {} on malformed data. */
export function parseSettings(s: string): Record<string, unknown> {
  try { return JSON.parse(s) } catch { return {} }
}

export async function getAppSetting(key: string, fallback: string): Promise<string> {
  const row = await db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  return row?.value ?? fallback
}

/** Invalidates every JWT already issued to a user. Call on role change, password change,
 *  and anywhere else an existing session must stop being trusted. */
export async function bumpTokenVersion(userId: string): Promise<void> {
  await db.update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId))
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await db.insert(appSettings).values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
}
