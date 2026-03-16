import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

const DB_PATH = process.env.DB_PATH ?? 'queriocity.db'

const sqlite = new Database(DB_PATH)
sqlite.loadExtension(sqliteVec.getLoadablePath())

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

export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  userId: text('user_id').notNull(),
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
  userId: text('user_id').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// --- Init ---

export const EMBED_DIMS = parseInt(process.env.EMBED_DIMENSIONS ?? '1536')

function initSchema() {
  // Recreate file_chunks if the embedding dimension changed
  const existing = sqlite.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='file_chunks'"
  ).get() as { sql: string } | null
  if (existing && !existing.sql.includes(`FLOAT[${EMBED_DIMS}]`)) {
    console.log(`[db] Embedding dimension changed → recreating file_chunks (${EMBED_DIMS} dims), clearing uploaded files`)
    sqlite.run('DROP TABLE IF EXISTS file_chunks')
    sqlite.run('DELETE FROM file_chunk_meta')
    sqlite.run('DELETE FROM uploaded_files')
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
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      user_id    TEXT NOT NULL
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
      user_id    TEXT NOT NULL,
      filename   TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      size       INTEGER NOT NULL,
      created_at INTEGER NOT NULL
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
}

initSchema()

export { sqlite }
