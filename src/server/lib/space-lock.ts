import { isIP } from 'node:net'
import { and, count, eq, ne } from 'drizzle-orm'
import { db, spaces, chatSessions, spaceMemories, spaceFiles, monitors } from './db.ts'
import { isBlockedAddress } from './url-guard.ts'

/** Locked ("offline") spaces: no web search, no URL fetching, no image generation.
 *
 *  The point of the feature is that a sensitive document analysed in such a space has no route out,
 *  so every question here is "can content reach a context that still has web access?" — which turns
 *  out to have four answers, only one of them obvious. See `assertNoEscape` below. */

/** Whether the space is locked. `undefined`/null spaceId — a chat outside any space — is never
 *  locked, which is exactly why moving a chat out of a locked space has to be refused. */
export async function isSpaceLocked(spaceId: string | null | undefined): Promise<boolean> {
  if (!spaceId) return false
  const row = await db.select({ offline: spaces.offline }).from(spaces)
    .where(eq(spaces.id, spaceId)).get()
  return row?.offline === true
}

export interface SpaceContents {
  chats: number
  memories: number
  files: number
}

/** What a space holds. Used to decide whether locking needs confirming and whether unlocking is
 *  allowed at all — both hinge on the space being empty. */
export async function spaceContents(spaceId: string): Promise<SpaceContents> {
  const [chats, memories, files] = await Promise.all([
    db.select({ n: count() }).from(chatSessions).where(eq(chatSessions.spaceId, spaceId)).get(),
    db.select({ n: count() }).from(spaceMemories).where(eq(spaceMemories.spaceId, spaceId)).get(),
    db.select({ n: count() }).from(spaceFiles).where(eq(spaceFiles.spaceId, spaceId)).get(),
  ])
  return { chats: chats?.n ?? 0, memories: memories?.n ?? 0, files: files?.n ?? 0 }
}

export const isEmptySpace = (c: SpaceContents): boolean =>
  c.chats === 0 && c.memories === 0 && c.files === 0

/** Human-readable contents, for the message explaining why unlocking is refused. */
export function describeContents(c: SpaceContents): string {
  const parts: string[] = []
  if (c.chats) parts.push(`${c.chats} chat${c.chats === 1 ? '' : 's'}`)
  if (c.memories) parts.push(`${c.memories} memor${c.memories === 1 ? 'y' : 'ies'}`)
  if (c.files) parts.push(`${c.files} tagged file${c.files === 1 ? '' : 's'}`)
  return parts.join(', ')
}

/** Locked spaces that still hold something cannot be unlocked.
 *
 *  Unlocking would retroactively hand web access to every chat and memory built up while the space
 *  was sealed, which is precisely what the user was promised would not happen. Emptying the space
 *  first is the deliberate way out — it makes the decision destructive and explicit rather than a
 *  toggle someone flips back without thinking. */
/** Monitors assigned to a space. A monitor is a scheduled web-research run, so a space holding one
 *  cannot be locked — the same rule `monitors.ts` enforces when a monitor is assigned to a space,
 *  which was previously stated on one side only and left locking as the way around it. */
export async function monitorsInSpace(spaceId: string): Promise<number> {
  const row = await db.select({ n: count() }).from(monitors).where(eq(monitors.spaceId, spaceId)).get()
  return row?.n ?? 0
}

export async function canUnlock(spaceId: string): Promise<{ ok: boolean; contents: SpaceContents }> {
  const contents = await spaceContents(spaceId)
  return { ok: isEmptySpace(contents), contents }
}

/** Whether a chat may move from `fromSpaceId` to `toSpaceId`.
 *
 *  A chat in a locked space carries content that was read under a promise of no egress. Moving it
 *  anywhere that still has web access breaks that promise, and `null` — no space at all — is the
 *  most permissive destination of the lot, not the safest. Its auto-memories travel with it
 *  (routes/history.ts), so this covers those too. */
export async function canMoveChat(
  fromSpaceId: string | null,
  toSpaceId: string | null,
): Promise<boolean> {
  if (!await isSpaceLocked(fromSpaceId)) return true
  return await isSpaceLocked(toSpaceId)
}

/** Session ids in a space, for deleting them along with it.
 *
 *  `chat_sessions.space_id` is ON DELETE SET NULL, so dropping a locked space would otherwise
 *  orphan its chats into ordinary unlocked ones — the quietest of the escape routes, since nothing
 *  in the UI suggests deleting a space touches the lock at all. */
export async function sessionIdsInSpace(spaceId: string): Promise<string[]> {
  const rows = await db.select({ id: chatSessions.id }).from(chatSessions)
    .where(eq(chatSessions.spaceId, spaceId)).all()
  return rows.map(r => r.id)
}

/** True when any space other than `exceptId` is locked — used only for clearer error text. */
export async function hasOtherLockedSpace(userId: string, exceptId: string): Promise<boolean> {
  const row = await db.select({ id: spaces.id }).from(spaces)
    .where(and(eq(spaces.userId, userId), eq(spaces.offline, true), ne(spaces.id, exceptId))).get()
  return !!row
}

/** Model endpoints that are not on this machine or LAN.
 *
 *  A locked space removes the model's *tools*, but the model itself is sent the whole document in
 *  the first request. If the chat endpoint is a hosted API the document has already left before any
 *  tool could exist, and a badge promising isolation would be worse than no badge at all. The
 *  reranker matters for the same reason — it is sent chunk text.
 *
 *  Reuses `isBlockedAddress` from url-guard, which classifies loopback/RFC1918/CGNAT/link-local.
 *  That function exists to decide what a fetch must *not* reach; inverted, it is exactly "this is
 *  my own machine or my own network". Hostnames are not resolved: this is advisory text on a
 *  settings screen, not an access decision, and a DNS round-trip per request is not worth it. */
export function remoteModelEndpoints(): string[] {
  const remote: string[] = []
  for (const name of ['CHAT_BASE_URL', 'EMBED_BASE_URL', 'RERANK_BASE_URL', 'BASE_URL'] as const) {
    const raw = process.env[name]
    if (!raw) continue
    let host: string
    try { host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { continue }
    if (host === 'localhost' || LOCAL_HOST_SUFFIXES.some(s => host.endsWith(s))) continue
    // A bare hostname that is not obviously internal is treated as remote, which errs toward
    // warning. Anything that parses as an IP is judged precisely.
    if (isIP(host) ? !isBlockedAddress(host) : true) remote.push(`${name}=${host}`)
  }
  return remote
}

const LOCAL_HOST_SUFFIXES = ['.localhost', '.internal', '.local', '.lan', 'host.docker.internal']
