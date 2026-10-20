import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq, sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { migrate } from './migrations.ts'

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
  /** Admin-granted, never part of `settings`, which the user can PATCH themselves. */
  cloudEnabled: integer('cloud_enabled', { mode: 'boolean' }).notNull().default(false),
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
 *  monitors. For a collection `offline` means confidential, which makes every resource in it
 *  confidential; see lib/files/confidential.ts. One table rather than two because everything a collection needs already exists
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
  /** JSON ContextReport of the latest turn, so the context meter survives switching chats. */
  contextReport: text('context_report'),
  /** JSON HistorySummary: the compressed-history summary, extended turn by turn. */
  historySummary: text('history_summary'),
  /** Locked for good once a turn read a confidential collection or resource: its history holds that
   *  content, so every later turn is locked too, wherever the chat sits. */
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
  /** JSON array: the confidential collections and resources that locked it, named for its banner. */
  lockedBy: text('locked_by'),
  /** Set while the title is a weak first one the small model may replace (lib/chat-title.ts): the
   *  scope prefix the replacement keeps, '' for none. Cleared by that replacement or a rename. */
  autoTitleScope: text('auto_title_scope'),
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
  /** Kept in full when a long conversation is trimmed to fit the model's context. */
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  /** JSON `AnswerModel` when a picked model answered; null for the default model. Records which
   *  answers left the server for a cloud provider. */
  model: text('model'),
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
  /** Confidential: only locked turns may read it — see lib/files/confidential.ts. Removable at any time. */
  confidential: integer('confidential', { mode: 'boolean' }).notNull().default(false),
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
  /** The chat and answer a note was saved from. Plain ids with no foreign key: the chat can be
   *  deleted on three separate paths, so instead of nulling it on each the link is resolved on read,
   *  owner-checked, and simply shows nothing once the chat is gone. */
  originSessionId: text('origin_session_id'),
  originMessageId: text('origin_message_id'),
  /** Who wrote a note: `human`, or the label of the model that wrote it. Null means unknown (notes
   *  saved before this was recorded) and for files. See shared/note-trust.ts. */
  generatedBy: text('generated_by'),
  /** When the owner marked the note reviewed; null when not. Notes are per user, so the reviewer is
   *  always the owner. */
  verifiedAt: integer('verified_at', { mode: 'timestamp' }),
  /** When the owner last changed the text of a note a model (or an unknown author) wrote; null when
   *  never. Not a review: an edit may touch one sentence. */
  editedAt: integer('edited_at', { mode: 'timestamp' }),
  /** draft | stable | deprecated, after OKF's lifecycle. Null means stable. */
  status: text('status', { enum: ['draft', 'stable', 'deprecated'] }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

/** A user's tags: hierarchical paths such as `ml/rag`, lowercase and `/`-separated. A parent exists
 *  implicitly through its children and has no row of its own. Rows exist only while some resource
 *  carries them — an unused tag is deleted, so the list never fills with dead ones.
 *
 *  Deliberately separate from `topics`: those are the small model's suggestions and are rewritten
 *  whenever a note's text changes, while a tag is the user's and nothing automatic touches it. */
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
})

export const resourceTags = sqliteTable('resource_tags', {
  resourceId: text('resource_id').notNull().references(() => uploadedFiles.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, (t) => ({ pk: primaryKey({ columns: [t.resourceId, t.tagId] }) }))

/** `[[wikilinks]]` from a note, rebuilt from its body on every save. `dstId` is null while the link
 *  names a title no resource has yet; creating or renaming one to that title resolves it. */
export const resourceLinks = sqliteTable('resource_links', {
  srcId: text('src_id').notNull().references(() => uploadedFiles.id, { onDelete: 'cascade' }),
  dstId: text('dst_id').references(() => uploadedFiles.id, { onDelete: 'set null' }),
  dstTitle: text('dst_title').notNull(),
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
  /** A recipe's parts (lib/recipes.ts), JSON; null on a plain template. */
  instructionNoteIds: text('instruction_note_ids'),
  instructionText: text('instruction_text'),
  exampleFileIds: text('example_file_ids'),
  settings: text('settings'),
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
 *  Exported for the test that guards that; ensureVectorTables is the only caller in production. */
export function resetFileEmbeddings(): void {
  sqlite.run('DROP TABLE IF EXISTS file_chunks')
}

/** Runs on every start, after the migrations: the vector tables follow EMBED_DIMENSIONS, which can
 *  change between starts, so they are checked each time rather than versioned. */
function ensureVectorTables(): void {
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

  sqlite.run(`CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks USING vec0(
    chunk_id TEXT PRIMARY KEY,
    embedding FLOAT[${EMBED_DIMS}]
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
}

/** Personal monitors without a timezone take their owner's, once the owner has set one. Every start,
 *  because the owner may set it long after the monitor was created. */
function backfillMonitorTimezones(): void {
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

migrate(sqlite)
ensureVectorTables()
backfillMonitorTimezones()

export { sqlite }

/** Safely parse a user's settings JSON, returning {} on malformed data. */
export function parseSettings(s: string): Record<string, unknown> {
  try { return JSON.parse(s) } catch { return {} }
}

export async function getAppSetting(key: string, fallback: string): Promise<string> {
  const row = await db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  return row?.value ?? fallback
}

/** getAppSetting for a caller that cannot await: one primary-key lookup. */
export function getAppSettingSync(key: string, fallback: string): string {
  const row = sqlite.query('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | null
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
