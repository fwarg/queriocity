#!/usr/bin/env bun
/**
 * Import Claude AI data export into Queriocity.
 * Usage: bun run scripts/import-claude.ts [--data-dir <path>] [--user-id <id>] [--dry-run]
 *
 * Projects → spaces, conversations → chat_sessions (unassigned), messages → messages.
 * Uses INSERT OR IGNORE so re-running is safe.
 */
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import * as readline from 'readline'

// --- Args ---

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : undefined
}
const dataDir = resolve(flag('--data-dir') ?? '../claudeai')
const dryRun = args.includes('--dry-run')
const userIdArg = flag('--user-id')

// --- Load data ---

console.log(`Loading data from ${dataDir} …`)
let projects: ClaudeProject[], conversations: ClaudeConversation[]
try {
  projects = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8'))
  conversations = JSON.parse(readFileSync(join(dataDir, 'conversations.json'), 'utf8'))
} catch (e) {
  console.error(`Failed to read data files: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}

// --- DB ---

const DB_PATH = process.env.DB_PATH ?? 'queriocity.db'
const db = new Database(DB_PATH)

// --- User selection ---

type DbUser = { id: string; email: string; name: string | null }
const users = db.query<DbUser, []>('SELECT id, email, name FROM users').all()
if (users.length === 0) {
  console.error('No users found in the database.')
  process.exit(1)
}

let userId: string
if (userIdArg) {
  if (!users.find(u => u.id === userIdArg)) {
    console.error(`User id "${userIdArg}" not found.`)
    process.exit(1)
  }
  userId = userIdArg
} else if (users.length === 1) {
  userId = users[0].id
  console.log(`User: ${users[0].name ?? users[0].email}`)
} else {
  console.log('\nAvailable users:')
  users.forEach((u, i) => console.log(`  ${i + 1}. ${u.name ?? u.email}  (${u.id})`))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>(resolve => rl.question('\nSelect user number: ', resolve))
  rl.close()
  const idx = parseInt(answer.trim(), 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= users.length) {
    console.error('Invalid selection.')
    process.exit(1)
  }
  userId = users[idx].id
  console.log(`Selected: ${users[idx].name ?? users[idx].email}`)
}

// --- Preview ---

const toSec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

let totalMsgs = 0
for (const conv of conversations) {
  totalMsgs += conv.chat_messages.filter(m => m.text?.trim()).length
}

console.log(`\nTo import:`)
console.log(`  ${projects.length} projects → spaces`)
console.log(`  ${conversations.length} conversations → chat sessions (all unassigned)`)
console.log(`  ${totalMsgs} messages`)

if (dryRun) {
  console.log('\n[dry-run] No changes written.')
  process.exit(0)
}

// --- Insert ---

const insertSpace = db.prepare(
  `INSERT OR IGNORE INTO spaces (id, name, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
)
const insertSession = db.prepare(
  `INSERT OR IGNORE INTO chat_sessions (id, title, user_id, space_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`
)
const insertMsg = db.prepare(
  `INSERT OR IGNORE INTO messages (id, session_id, role, content, sources, created_at) VALUES (?, ?, ?, ?, NULL, ?)`
)

let spacesAdded = 0, chatsAdded = 0, msgsAdded = 0

db.transaction(() => {
  for (const p of projects) {
    const r = insertSpace.run(p.uuid, p.name, userId, toSec(p.created_at), toSec(p.updated_at))
    spacesAdded += r.changes
  }

  for (const conv of conversations) {
    const r = insertSession.run(conv.uuid, conv.name, userId, toSec(conv.created_at), toSec(conv.updated_at))
    chatsAdded += r.changes

    for (const msg of conv.chat_messages) {
      const text = msg.text?.trim()
      if (!text) continue
      const role = msg.sender === 'human' ? 'user' : 'assistant'
      const r2 = insertMsg.run(msg.uuid, conv.uuid, role, text, toSec(msg.created_at))
      msgsAdded += r2.changes
    }
  }
})()

console.log(`\nImported:`)
console.log(`  ${spacesAdded} spaces  (${projects.length - spacesAdded} already existed)`)
console.log(`  ${chatsAdded} chats   (${conversations.length - chatsAdded} already existed)`)
console.log(`  ${msgsAdded} messages (${totalMsgs - msgsAdded} already existed)`)
console.log(`\nAll chats are unassigned. Move them to spaces via the Queriocity UI.`)

// --- Types ---

interface ClaudeProject {
  uuid: string
  name: string
  created_at: string
  updated_at: string
}

interface ClaudeConversation {
  uuid: string
  name: string
  created_at: string
  updated_at: string
  chat_messages: ClaudeMessage[]
}

interface ClaudeMessage {
  uuid: string
  sender: 'human' | 'assistant'
  text: string
  created_at: string
}
