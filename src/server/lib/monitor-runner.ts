import { db, monitors, monitorSubscriptions, monitorRuns, chatSessions, messages } from './db.ts'
import { eq, and, lte, desc, count } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { executeChatAndSave } from './chat-executor.ts'

let running = false

export async function runDueMonitors(): Promise<void> {
  if (running) return
  running = true
  try {
    const now = new Date()
    const due = await db.select().from(monitors)
      .where(and(eq(monitors.enabled, true), lte(monitors.nextRunAt, now)))

    for (const monitor of due) {
      try {
        let userIds: string[]
        if (monitor.isGlobal) {
          const subs = await db.select({ userId: monitorSubscriptions.userId })
            .from(monitorSubscriptions).where(eq(monitorSubscriptions.monitorId, monitor.id))
          userIds = subs.map(s => s.userId)
        } else {
          userIds = monitor.userId ? [monitor.userId] : []
        }

        for (const userId of userIds) {
          try {
            await runMonitorForUser(monitor, userId)
          } catch (e) {
            console.error(`[monitor] run failed for monitor=${monitor.id} user=${userId}:`, e)
          }
        }

        const nextRunAt = new Date(now.getTime() + monitor.intervalMinutes * 60_000)
        await db.update(monitors).set({ nextRunAt, lastRunAt: now, updatedAt: now }).where(eq(monitors.id, monitor.id))
      } catch (e) {
        console.error(`[monitor] processing failed for monitor=${monitor.id}:`, e)
      }
    }
  } finally {
    running = false
  }
}

export async function runMonitorNow(
  monitor: typeof monitors.$inferSelect,
  userId: string,
): Promise<void> {
  await runMonitorForUser(monitor, userId)
}

async function runMonitorForUser(
  monitor: typeof monitors.$inferSelect,
  userId: string,
): Promise<void> {
  console.log(`  [monitor] running "${monitor.name}" for user=${userId}`)
  const sessionId = randomUUID()
  const focusMode = monitor.focusMode as 'flash' | 'balanced' | 'thorough'

  await executeChatAndSave({
    sessionId,
    userId,
    title: monitor.name,
    promptText: monitor.promptText,
    focusMode: ['flash', 'balanced', 'thorough'].includes(focusMode) ? focusMode : 'balanced',
    spaceId: monitor.spaceId ?? undefined,
  })

  const now = new Date()
  await db.insert(monitorRuns).values({
    id: randomUUID(),
    monitorId: monitor.id,
    userId,
    sessionId,
    runAt: now,
  })

  await pruneRuns(monitor.id, userId, monitor.keepCount)
}

async function pruneRuns(monitorId: string, userId: string, keepCount: number): Promise<void> {
  const runs = await db.select({ id: monitorRuns.id, sessionId: monitorRuns.sessionId })
    .from(monitorRuns)
    .where(and(eq(monitorRuns.monitorId, monitorId), eq(monitorRuns.userId, userId)))
    .orderBy(desc(monitorRuns.runAt))

  if (runs.length <= keepCount) return

  const toDelete = runs.slice(keepCount)
  for (const run of toDelete) {
    const msgCount = await db.select({ n: count() }).from(messages).where(eq(messages.sessionId, run.sessionId)).get()
    if ((msgCount?.n ?? 0) > 2) {
      // User added follow-ups — keep the session (it becomes a regular chat) but drop the run record
      await db.delete(monitorRuns).where(eq(monitorRuns.id, run.id))
    } else {
      await db.delete(monitorRuns).where(eq(monitorRuns.id, run.id))
      await db.delete(chatSessions).where(eq(chatSessions.id, run.sessionId))
    }
  }
}
