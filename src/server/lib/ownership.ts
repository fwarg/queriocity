import { and, eq } from 'drizzle-orm'
import { db, spaces, chatSessions } from './db.ts'

/** True when the space exists and belongs to the user. Callers should 404 (not 403) on false,
 *  so a probe can't distinguish "someone else's space" from "no such space". */
export async function ownsSpace(spaceId: string, userId: string): Promise<boolean> {
  const row = await db.select({ id: spaces.id }).from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.userId, userId))).get()
  return !!row
}

export type SessionOwnership = 'own' | 'free' | 'other'

/** 'free' means no session with that id exists yet — the client generates session ids
 *  optimistically, so that is the normal case for a first message. */
export async function sessionOwnership(sessionId: string, userId: string): Promise<SessionOwnership> {
  const row = await db.select({ userId: chatSessions.userId }).from(chatSessions)
    .where(eq(chatSessions.id, sessionId)).get()
  if (!row) return 'free'
  return row.userId === userId ? 'own' : 'other'
}
