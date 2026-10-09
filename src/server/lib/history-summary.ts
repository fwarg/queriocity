/** Per-chat storage of the compressed-history summary, so each turn extends it instead of
 *  re-summarising everything that was trimmed. */
import { eq } from 'drizzle-orm'
import { db, chatSessions } from './db.ts'
import type { HistorySummary } from './trim-messages.ts'

/** The stored summary of a chat, or undefined when there is none or it is unreadable. */
export async function loadHistorySummary(sessionId?: string): Promise<HistorySummary | undefined> {
  if (!sessionId) return undefined
  const row = await db.select({ s: chatSessions.historySummary }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get()
  if (!row?.s) return undefined
  try {
    const parsed = JSON.parse(row.s) as HistorySummary
    return typeof parsed.summary === 'string' && Array.isArray(parsed.hashes) && typeof parsed.lost === 'number' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Stores a chat's summary. A chat not yet stored (its first turn, or ephemeral) keeps nothing. */
export async function saveHistorySummary(sessionId: string, summary: HistorySummary): Promise<void> {
  await db.update(chatSessions).set({ historySummary: JSON.stringify(summary) }).where(eq(chatSessions.id, sessionId))
}
