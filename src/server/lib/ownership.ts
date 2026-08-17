import { and, eq } from 'drizzle-orm'
import { db, spaces, chatSessions } from './db.ts'

/** True when the space exists and belongs to the user. Callers should 404 (not 403) on false,
 *  so a probe can't distinguish "someone else's space" from "no such space". */
export async function ownsSpace(spaceId: string, userId: string): Promise<boolean> {
  const row = await db.select({ id: spaces.id }).from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.userId, userId))).get()
  return !!row
}

/** True when the row is a collection — a grouping of resources, with no chats, memories or monitors.
 *
 *  Collections share the `spaces` table, so every route that attaches something *chat-shaped* to a
 *  space has to say no here. The alternative, folding this into `ownsSpace`, would silently change
 *  what that function means for the resource routes, which legitimately accept both kinds. */
export async function isCollection(spaceId: string): Promise<boolean> {
  const row = await db.select({ kind: spaces.kind }).from(spaces).where(eq(spaces.id, spaceId)).get()
  return row?.kind === 'collection'
}

/** The message every route uses when something chat-shaped is aimed at a collection. */
export const COLLECTION_HOLDS_NO_CHATS =
  'That is a collection. Collections group resources only — pick a space, or promote the collection first.'

export type SessionOwnership = 'own' | 'free' | 'other'

/** 'free' means no session with that id exists yet — the client generates session ids
 *  optimistically, so that is the normal case for a first message. */
export async function sessionOwnership(sessionId: string, userId: string): Promise<SessionOwnership> {
  const row = await db.select({ userId: chatSessions.userId }).from(chatSessions)
    .where(eq(chatSessions.id, sessionId)).get()
  if (!row) return 'free'
  return row.userId === userId ? 'own' : 'other'
}
