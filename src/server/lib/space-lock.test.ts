import './test-support/test-env.ts'
import { describe, expect, it, beforeEach, beforeAll } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { db, users, spaces, chatSessions, spaceMemories, monitors } from './db.ts'
import { canMoveChat, canUnlock, describeContents, isSpaceLocked, monitorsInSpace, sessionIdsInSpace } from './space-lock.ts'

const USER = 'u-lock'

// spaces.user_id is a real foreign key, and PRAGMA foreign_keys is ON.
beforeAll(async () => {
  await db.insert(users).values({
    id: USER, email: `${USER}@test.invalid`, createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing()
})

async function makeSpace(offline: boolean): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await db.insert(spaces).values({ id, name: `s-${id.slice(0, 6)}`, userId: USER, offline, createdAt: now, updatedAt: now })
  return id
}

async function makeChat(spaceId: string | null): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await db.insert(chatSessions).values({ id, title: 't', userId: USER, spaceId, createdAt: now, updatedAt: now })
  return id
}

async function makeMonitor(spaceId: string): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await db.insert(monitors).values({
    id, userId: USER, name: `m-${id.slice(0, 6)}`, promptText: 'what changed?',
    intervalMinutes: 1440, spaceId, createdAt: now, updatedAt: now,
  })
  return id
}

beforeEach(async () => {
  await db.delete(chatSessions)
  await db.delete(spaces)
})

describe('isSpaceLocked', () => {
  it('is false for a chat in no space — the permissive case, not the safe one', async () => {
    expect(await isSpaceLocked(null)).toBe(false)
    expect(await isSpaceLocked(undefined)).toBe(false)
  })

  it('reflects the column', async () => {
    expect(await isSpaceLocked(await makeSpace(true))).toBe(true)
    expect(await isSpaceLocked(await makeSpace(false))).toBe(false)
  })
})

/** Every one of these is an escape route out of a locked space. They are separate doors reached by
 *  different buttons, and each has to stay shut independently. */
describe('escape routes', () => {
  it('refuses moving a locked chat to an unlocked space', async () => {
    const locked = await makeSpace(true)
    const open = await makeSpace(false)
    expect(await canMoveChat(locked, open)).toBe(false)
  })

  it('refuses moving a locked chat out to no space at all', async () => {
    const locked = await makeSpace(true)
    expect(await canMoveChat(locked, null)).toBe(false)
  })

  it('allows moving between two locked spaces', async () => {
    expect(await canMoveChat(await makeSpace(true), await makeSpace(true))).toBe(true)
  })

  it('allows moving an unlocked chat into a locked space — that only tightens', async () => {
    expect(await canMoveChat(await makeSpace(false), await makeSpace(true))).toBe(true)
    expect(await canMoveChat(null, await makeSpace(true))).toBe(true)
  })

  it('lists the sessions that must be deleted with a locked space', async () => {
    const locked = await makeSpace(true)
    const a = await makeChat(locked)
    const b = await makeChat(locked)
    await makeChat(await makeSpace(false))
    expect((await sessionIdsInSpace(locked)).sort()).toEqual([a, b].sort())
  })
})

describe('canUnlock', () => {
  it('allows unlocking an empty space', async () => {
    const { ok } = await canUnlock(await makeSpace(true))
    expect(ok).toBe(true)
  })

  it('refuses once the space holds a chat, and reports what is in the way', async () => {
    const locked = await makeSpace(true)
    await makeChat(locked)
    const { ok, contents } = await canUnlock(locked)
    expect(ok).toBe(false)
    expect(contents.chats).toBe(1)
    expect(describeContents(contents)).toBe('1 chat')
  })

  it('counts memories too, not just chats', async () => {
    const locked = await makeSpace(true)
    const sessionId = await makeChat(locked)
    await db.insert(spaceMemories).values({
      id: randomUUID(), spaceId: locked, sessionId, content: 'x', source: 'tool',
      createdAt: new Date(), updatedAt: new Date(),
    })
    const { contents } = await canUnlock(locked)
    expect(describeContents(contents)).toBe('1 chat, 1 memory')
  })
})

/** The rule was enforced on one side only: monitors.ts refuses assigning a monitor to a locked
 *  space, but locking a space that already held one was allowed, and the scheduled web research
 *  carried on inside it. */
describe('monitorsInSpace', () => {
  it('is zero for a space with none', async () => {
    expect(await monitorsInSpace(await makeSpace(false))).toBe(0)
  })

  it('counts the monitors that block locking', async () => {
    const space = await makeSpace(false)
    await makeMonitor(space)
    await makeMonitor(space)
    expect(await monitorsInSpace(space)).toBe(2)
  })

  it('does not count a monitor belonging to another space', async () => {
    const [space, other] = [await makeSpace(false), await makeSpace(false)]
    await makeMonitor(other)
    expect(await monitorsInSpace(space)).toBe(0)
  })
})
