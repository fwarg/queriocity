import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db, monitors, monitorSubscriptions, monitorRuns } from '../lib/db.ts'
import { eq, and, or, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { runMonitorNow } from '../lib/monitor-runner.ts'

export const monitorsRouter = new Hono<AppEnv>()

monitorsRouter.use('*', authMiddleware)

const monitorBody = z.object({
  name: z.string().min(1).max(100),
  promptText: z.string().min(1).max(10000),
  focusMode: z.enum(['flash', 'balanced', 'thorough']).default('balanced'),
  intervalMinutes: z.number().int().min(60),
  keepCount: z.number().int().min(1).max(20).default(3),
  spaceId: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
})

function toUnix(d: Date | null | undefined): number | undefined {
  if (!d) return undefined
  return Math.floor(d.getTime() / 1000)
}

function serializeMonitor(m: typeof monitors.$inferSelect, subscribed?: boolean) {
  return {
    id: m.id,
    name: m.name,
    promptText: m.promptText,
    focusMode: m.focusMode,
    intervalMinutes: m.intervalMinutes,
    keepCount: m.keepCount,
    isGlobal: m.isGlobal,
    spaceId: m.spaceId,
    enabled: m.enabled,
    nextRunAt: toUnix(m.nextRunAt),
    lastRunAt: toUnix(m.lastRunAt),
    createdAt: toUnix(m.createdAt)!,
    ...(subscribed !== undefined ? { subscribed } : {}),
  }
}

// Admin: list all global monitors — must be before /:id
monitorsRouter.get('/global', async (c) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const rows = await db.select().from(monitors)
    .where(eq(monitors.isGlobal, true))
    .orderBy(desc(monitors.createdAt))
  return c.json(rows.map(m => serializeMonitor(m)))
})

// Admin: create global monitor — must be before /:id
monitorsRouter.post('/global', zValidator('json', monitorBody), async (c) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const now = new Date()
  const id = randomUUID()
  const nextRunAt = new Date(now.getTime() + body.intervalMinutes * 60_000)

  await db.insert(monitors).values({
    id,
    userId: null,
    name: body.name,
    promptText: body.promptText,
    focusMode: body.focusMode,
    intervalMinutes: body.intervalMinutes,
    keepCount: body.keepCount,
    isGlobal: true,
    spaceId: null,
    enabled: body.enabled,
    nextRunAt,
    createdAt: now,
    updatedAt: now,
  })

  const row = await db.select().from(monitors).where(eq(monitors.id, id)).get()
  return c.json(serializeMonitor(row!), 201)
})

// Admin: update global monitor — must be before /:id
monitorsRouter.patch('/global/:id', zValidator('json', monitorBody.partial()), async (c) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id')
  const body = c.req.valid('json')

  const monitor = await db.select().from(monitors)
    .where(and(eq(monitors.id, id), eq(monitors.isGlobal, true))).get()
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  const nextRunAt = body.intervalMinutes && body.intervalMinutes !== monitor.intervalMinutes
    ? new Date(now.getTime() + body.intervalMinutes * 60_000)
    : undefined

  await db.update(monitors).set({
    ...body,
    ...(nextRunAt ? { nextRunAt } : {}),
    updatedAt: now,
  }).where(eq(monitors.id, id))

  return c.json({ ok: true })
})

// Admin: delete global monitor — must be before /:id
monitorsRouter.delete('/global/:id', async (c) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id')
  const monitor = await db.select().from(monitors)
    .where(and(eq(monitors.id, id), eq(monitors.isGlobal, true))).get()
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  await db.delete(monitors).where(eq(monitors.id, id))
  return c.json({ ok: true })
})

// List user's own monitors + subscribed global monitors
monitorsRouter.get('/', async (c) => {
  const userId = c.get('userId') as string

  const ownMonitors = await db.select().from(monitors)
    .where(eq(monitors.userId, userId))
    .orderBy(desc(monitors.createdAt))

  const subscribedRows = await db.select({ monitorId: monitorSubscriptions.monitorId })
    .from(monitorSubscriptions)
    .where(eq(monitorSubscriptions.userId, userId))
  const subscribedIds = subscribedRows.map(r => r.monitorId)

  const globalMonitors = subscribedIds.length > 0
    ? await db.select().from(monitors).where(
        and(eq(monitors.isGlobal, true), or(...subscribedIds.map(id => eq(monitors.id, id))))
      )
    : []

  const result = [
    ...ownMonitors.map(m => serializeMonitor(m)),
    ...globalMonitors.map(m => serializeMonitor(m, true)),
  ]
  return c.json(result)
})

// Create private monitor
monitorsRouter.post('/', zValidator('json', monitorBody), async (c) => {
  const userId = c.get('userId') as string
  const body = c.req.valid('json')
  const now = new Date()
  const id = randomUUID()
  const nextRunAt = new Date(now.getTime() + body.intervalMinutes * 60_000)

  await db.insert(monitors).values({
    id,
    userId,
    name: body.name,
    promptText: body.promptText,
    focusMode: body.focusMode,
    intervalMinutes: body.intervalMinutes,
    keepCount: body.keepCount,
    isGlobal: false,
    spaceId: body.spaceId ?? null,
    enabled: body.enabled,
    nextRunAt,
    createdAt: now,
    updatedAt: now,
  })

  const row = await db.select().from(monitors).where(eq(monitors.id, id)).get()
  return c.json(serializeMonitor(row!), 201)
})

// Update own monitor
monitorsRouter.patch('/:id', zValidator('json', monitorBody.partial()), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const monitor = await db.select().from(monitors)
    .where(and(eq(monitors.id, id), eq(monitors.userId, userId))).get()
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  const nextRunAt = body.intervalMinutes && body.intervalMinutes !== monitor.intervalMinutes
    ? new Date(now.getTime() + body.intervalMinutes * 60_000)
    : undefined

  await db.update(monitors).set({
    ...body,
    spaceId: body.spaceId !== undefined ? (body.spaceId ?? null) : undefined,
    ...(nextRunAt ? { nextRunAt } : {}),
    updatedAt: now,
  }).where(eq(monitors.id, id))

  return c.json({ ok: true })
})

// Delete own monitor
monitorsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const monitor = await db.select().from(monitors)
    .where(and(eq(monitors.id, id), eq(monitors.userId, userId))).get()
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  await db.delete(monitors).where(eq(monitors.id, id))
  return c.json({ ok: true })
})

// Trigger immediate run
monitorsRouter.post('/:id/run', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const monitor = await db.select().from(monitors).where(eq(monitors.id, id)).get()
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  if (!monitor.isGlobal && monitor.userId !== userId) return c.json({ error: 'Not found' }, 404)
  if (monitor.isGlobal) {
    const sub = await db.select().from(monitorSubscriptions)
      .where(and(eq(monitorSubscriptions.monitorId, id), eq(monitorSubscriptions.userId, userId))).get()
    if (!sub) return c.json({ error: 'Not subscribed' }, 403)
  }

  try {
    await runMonitorNow(monitor, userId)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Run failed' }, 500)
  }
})

// List runs for a monitor (current user's runs)
monitorsRouter.get('/:id/runs', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const monitor = await db.select().from(monitors).where(eq(monitors.id, id)).get()
  if (!monitor) return c.json({ error: 'Not found' }, 404)
  if (!monitor.isGlobal && monitor.userId !== userId) return c.json({ error: 'Not found' }, 404)

  const runs = await db.select().from(monitorRuns)
    .where(and(eq(monitorRuns.monitorId, id), eq(monitorRuns.userId, userId)))
    .orderBy(desc(monitorRuns.runAt))

  return c.json(runs.map(r => ({
    id: r.id,
    monitorId: r.monitorId,
    sessionId: r.sessionId,
    runAt: Math.floor((r.runAt as Date).getTime() / 1000),
  })))
})

// Subscribe to a global monitor
monitorsRouter.post('/:id/subscribe', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  const monitor = await db.select().from(monitors).where(eq(monitors.id, id)).get()
  if (!monitor || !monitor.isGlobal) return c.json({ error: 'Not found' }, 404)

  await db.insert(monitorSubscriptions).values({ monitorId: id, userId })
    .onConflictDoNothing()
  return c.json({ ok: true })
})

// Unsubscribe from a global monitor
monitorsRouter.delete('/:id/subscribe', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  await db.delete(monitorSubscriptions)
    .where(and(eq(monitorSubscriptions.monitorId, id), eq(monitorSubscriptions.userId, userId)))
  return c.json({ ok: true })
})
