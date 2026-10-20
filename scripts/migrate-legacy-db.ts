#!/usr/bin/env bun
/**
 * One-time conversion of a database from before the schema baseline to the current schema.
 * Usage: bun run scripts/migrate-legacy-db.ts <old.db> <new.db>
 *
 * Run with the server stopped, then put <new.db> in place of <old.db>. The old file is opened
 * read-only and never written, so it stays the backup.
 *
 * Copies every table by column name into a database created from SCHEMA. Columns the old database
 * lacks get their defaults — what the old in-place upgrades would have given them. A column, or a
 * table, that only the old database has aborts the run, since its data would be lost. Rows orphaned
 * before foreign keys were enforced (2026-04-26) — messages of deleted chats, memories of deleted
 * spaces — are left out; any other foreign-key violation aborts. Nothing is written unless every
 * check passes.
 */
import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { existsSync } from 'fs'
import { SCHEMA, BASELINE_VERSION, migrate } from '../src/server/lib/migrations.ts'

/** Columns renamed in place by earlier versions, old name → new, per table. */
const RENAMED: Record<string, Record<string, string>> = { uploaded_files: { locked: 'confidential' } }
/** Tables the old upgrades dropped; a database may still hold them, with nothing worth keeping. */
const DROPPED = new Set(['memory_chunks', 'space_memories_v2'])
/** Orphans expected from before foreign-key enforcement: child table → parent table. */
const LEGACY_ORPHANS: Record<string, string> = { messages: 'chat_sessions', space_memories: 'spaces' }
/** vec0 tables: copied with their dimension unchanged; db.ts recreates them if EMBED_DIMENSIONS differs. */
const VECTOR_TABLES = ['file_chunks', 'chat_chunks', 'memory_embeddings']

const [oldPath, newPath] = process.argv.slice(2)
if (!oldPath || !newPath) fail('Usage: bun run scripts/migrate-legacy-db.ts <old.db> <new.db>')
if (!existsSync(oldPath)) fail(`${oldPath} does not exist`)
if (existsSync(newPath)) fail(`${newPath} already exists — refusing to overwrite it`)

const old = new Database(oldPath, { readonly: true })
sqliteVec.load(old)
const oldVersion = versionOf(old)
if (oldVersion >= BASELINE_VERSION) {
  console.log(`${oldPath} is at schema version ${oldVersion}, already past the baseline — nothing to convert.`)
  process.exit(0)
}

const target = new Database(newPath)
sqliteVec.load(target)
try {
  target.transaction(() => {
    target.run(SCHEMA)
    const counts = copyTables()
    copyVectorTables(counts)
    const removed = removeLegacyOrphans()
    assertConsistent()
    report(counts, removed)
    target.run(`PRAGMA user_version = ${BASELINE_VERSION}`)
  })()
} catch (e) {
  target.close()
  await Bun.file(newPath).delete()
  fail(e instanceof Error ? e.message : String(e))
}
migrate(target)
target.close()
console.log(`\nDone: ${newPath} is at the current schema. Stop the server, put it in place of ${oldPath}, start again.`)

/** Copies each table of the new schema from the old database; returns rows copied per table. */
function copyTables(): Map<string, number> {
  const newTables = tableNames(target)
  const oldTables = tableNames(old)
  const unknown = oldTables.filter(t => !newTables.includes(t) && !DROPPED.has(t))
  if (unknown.length) throw new Error(`Tables only the old database has (data would be lost): ${unknown.join(', ')}`)

  const counts = new Map<string, number>()
  for (const table of newTables.filter(t => oldTables.includes(t))) {
    const renamed = RENAMED[table] ?? {}
    const oldCols = columnsOf(old, table)
    const newCols = new Set(columnsOf(target, table))
    const lost = oldCols.filter(c => !newCols.has(renamed[c] ?? c))
    if (lost.length) throw new Error(`${table}: columns only the old database has (data would be lost): ${lost.join(', ')}`)
    counts.set(table, copyRows(table, oldCols, oldCols.map(c => renamed[c] ?? c)))
  }
  return counts
}

/** Recreates each vec0 table with its old definition, so its dimension is kept, then copies it. */
function copyVectorTables(counts: Map<string, number>): void {
  for (const table of VECTOR_TABLES) {
    const ddl = old.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | null
    if (!ddl) continue
    target.run(ddl.sql)
    counts.set(table, copyRows(table, columnsOf(old, table), columnsOf(old, table)))
  }
}

function copyRows(table: string, from: string[], to: string[]): number {
  const insert = target.prepare(`INSERT INTO "${table}" (${to.map(c => `"${c}"`).join(', ')}) VALUES (${to.map(() => '?').join(', ')})`)
  let n = 0
  for (const row of old.query(`SELECT ${from.map(c => `"${c}"`).join(', ')} FROM "${table}"`).values()) {
    insert.run(...(row as never[]))
    n++
  }
  return n
}

/** Deletes the expected orphans, and returns how many per table. */
function removeLegacyOrphans(): Map<string, number> {
  const removed = new Map<string, number>()
  for (const [child, parent] of Object.entries(LEGACY_ORPHANS)) {
    const rowids = (target.query('SELECT rowid FROM pragma_foreign_key_check(?) WHERE parent = ?').all(child, parent) as Array<{ rowid: number }>)
      .map(r => r.rowid)
    const del = target.prepare(`DELETE FROM "${child}" WHERE rowid = ?`)
    for (const rowid of rowids) del.run(rowid)
    removed.set(child, rowids.length)
  }
  return removed
}

function assertConsistent(): void {
  const violations = target.query('SELECT "table" AS t, parent, count(*) AS n FROM pragma_foreign_key_check GROUP BY 1, 2').all() as Array<{ t: string; parent: string; n: number }>
  if (violations.length) {
    throw new Error(`Foreign-key violations other than the known legacy orphans:\n${violations.map(v => `  ${v.n} row(s) in ${v.t} → missing ${v.parent}`).join('\n')}`)
  }
  const integrity = (target.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
  if (integrity !== 'ok') throw new Error(`Integrity check failed: ${integrity}`)
  target.run("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')")
}

function report(counts: Map<string, number>, removed: Map<string, number>): void {
  console.log(`Converted ${oldPath} (schema version ${oldVersion}) → ${newPath} (version ${BASELINE_VERSION})\n`)
  for (const [table, n] of [...counts].sort()) {
    const gone = removed.get(table) ?? 0
    console.log(`  ${table.padEnd(24)} ${String(n - gone).padStart(7)}${gone ? `   (${gone} legacy orphan(s) left out)` : ''}`)
  }
}

function tableNames(d: Database): string[] {
  // GLOB, not LIKE: in LIKE an underscore matches any character. Skips virtual tables and the shadow
  // tables FTS5 and vec0 keep behind them; those are rebuilt, not copied.
  return (d.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT GLOB 'CREATE VIRTUAL TABLE*'
    AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'messages_fts_*' AND name NOT GLOB '*_chunks_*'
    AND name NOT GLOB 'memory_embeddings_*' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name)
}

function columnsOf(d: Database, table: string): string[] {
  return (d.query(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).map(r => r.name)
}

function versionOf(d: Database): number {
  return (d.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
