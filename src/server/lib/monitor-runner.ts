import { db, monitors, monitorSubscriptions, monitorRuns, chatSessions, messages, users, parseSettings } from './db.ts'
import { eq, and, lte, desc, count } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { executeChatAndSave } from './chat-executor.ts'

/** Convert a preferred hour in a given IANA timezone on the same calendar day as `near` to UTC. */
function localHourToUTC(hour: number, tz: string, near: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(near)
  const y = +parts.find(p => p.type === 'year')!.value
  const mo = +parts.find(p => p.type === 'month')!.value
  const d = +parts.find(p => p.type === 'day')!.value
  const asUTC = new Date(Date.UTC(y, mo - 1, d, hour, 0, 0))
  const actualHour = +new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false, hourCycle: 'h23',
  }).format(asUTC)
  return new Date(asUTC.getTime() - (actualHour - hour) * 3600_000)
}

/** Compute the next scheduled run time, optionally snapping to a preferred hour in a timezone. */
export function computeNextRunAt(
  intervalMinutes: number,
  preferredHour: number | null | undefined,
  timezone: string | null | undefined,
  now: Date,
  initial = false,
): Date {
  const nominalNext = new Date(now.getTime() + intervalMinutes * 60_000)
  if (preferredHour == null || intervalMinutes < 1440) return nominalNext
  const tz = timezone || 'UTC'
  // For initial creation, find the next occurrence from now.
  // For post-run rescheduling, allow ±12h slack so we stay close to the interval cadence.
  const earliest = initial ? now : new Date(nominalNext.getTime() - 12 * 3600_000)
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const probe = new Date(earliest.getTime() + dayOffset * 86400_000)
    const candidate = localHourToUTC(preferredHour, tz, probe)
    if (candidate >= earliest) return candidate
  }
  return nominalNext
}

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

        const ownerRow = monitor.userId
          ? await db.select({ settings: users.settings }).from(users).where(eq(users.id, monitor.userId)).get()
          : null
        const ownerTz = ownerRow ? (parseSettings(ownerRow.settings ?? '{}').timezone as string | undefined) : undefined
        const nextRunAt = computeNextRunAt(monitor.intervalMinutes, monitor.preferredHour, ownerTz, now)
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
  const now = new Date()
  await db.update(monitors).set({ lastRunAt: now, updatedAt: now }).where(eq(monitors.id, monitor.id))
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
