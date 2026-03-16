import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

const DB_PATH = process.env.DB_PATH ?? 'queriocity.db'

const sqlite = new Database(DB_PATH)
sqliteVec.load(sqlite)

export const db = drizzle(sqlite)

// --- Schema ---

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
  sources: text('sources'),  // JSON array of source objects
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

// --- Vector table (created directly via SQL) ---

export function initVectorTable() {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding FLOAT[1536]
    );
  `)
  // Metadata companion table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS file_chunk_meta (
      chunk_id TEXT PRIMARY KEY,
      file_id  TEXT NOT NULL,
      content  TEXT NOT NULL
    );
  `)
}

export function initSchema() {
  sqlite.exec(`
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
  initVectorTable()
}

initSchema()

export { sqlite }
