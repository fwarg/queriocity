import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

const DB_PATH = process.env.DB_PATH ?? 'queriocity.db'

const sqlite = new Database(DB_PATH)
sqlite.loadExtension(sqliteVec.getLoadablePath())
sqlite.run('PRAGMA foreign_keys = ON')

export const db = drizzle(sqlite)

// --- Schema ---

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  settings: text('settings').notNull().default('{}'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const authCredentials = sqliteTable('auth_credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
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

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
})

export const spaceMemories = sqliteTable('space_memories', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  source: text('source', { enum: ['tool', 'extraction', 'manual', 'compact'] }).notNull().default('tool'),
  sessionId: text('session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  sources: text('sources'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const uploadedFiles = sqliteTable('uploaded_files', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  contentHash: text('content_hash'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
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

function initSchema() {
  // Recreate file_chunks if the embedding dimension changed
  const existing = sqlite.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='file_chunks'"
  ).get() as { sql: string } | null
  if (existing && !existing.sql.includes(`FLOAT[${EMBED_DIMS}]`)) {
    if (!process.env.ALLOW_EMBED_RESET) {
      throw new Error(
        `[db] EMBED_DIMENSIONS changed to ${EMBED_DIMS} — set ALLOW_EMBED_RESET=true to wipe and recreate embedding tables (all uploads will be deleted)`
      )
    }
    console.log(`[db] Embedding dimension changed → recreating file_chunks (${EMBED_DIMS} dims), clearing uploaded files`)
    sqlite.run('DROP TABLE IF EXISTS file_chunks')
    sqlite.run('DELETE FROM file_chunk_meta')
    sqlite.run('DELETE FROM uploaded_files')
  }

  // Recreate chat_chunks if the embedding dimension changed
  const existingChat = sqlite.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_chunks'"
  ).get() as { sql: string } | null
  if (existingChat && !existingChat.sql.includes(`FLOAT[${EMBED_DIMS}]`)) {
    if (!process.env.ALLOW_EMBED_RESET) {
      throw new Error(
        `[db] EMBED_DIMENSIONS changed to ${EMBED_DIMS} — set ALLOW_EMBED_RESET=true to wipe and recreate embedding tables`
      )
    }
    console.log(`[db] Embedding dimension changed → recreating chat_chunks (${EMBED_DIMS} dims)`)
    sqlite.run('DROP TABLE IF EXISTS chat_chunks')
    sqlite.run('DELETE FROM chat_chunk_meta')
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
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS space_memories (
      id         TEXT PRIMARY KEY,
      space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'tool' CHECK(source IN ('tool','extraction','manual')),
      session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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

  // Migration: add 'compact' to space_memories source CHECK constraint
  try {
    sqlite.run(`CREATE TABLE IF NOT EXISTS space_memories_v2 (
      id         TEXT PRIMARY KEY,
      space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'tool' CHECK(source IN ('tool','extraction','manual','compact')),
      session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    sqlite.run(`INSERT OR IGNORE INTO space_memories_v2 SELECT * FROM space_memories`)
    sqlite.run(`DROP TABLE space_memories`)
    sqlite.run(`ALTER TABLE space_memories_v2 RENAME TO space_memories`)
  } catch {}

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
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN preferred_hour INTEGER') } catch {}
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN timezone TEXT') } catch {}
  try { sqlite.run('ALTER TABLE monitors ADD COLUMN feed_sources TEXT') } catch {}
  try { sqlite.run('ALTER TABLE uploaded_files ADD COLUMN content_hash TEXT') } catch {}
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

export async function setAppSetting(key: string, value: string): Promise<void> {
  await db.insert(appSettings).values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
}
