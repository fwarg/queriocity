// Keeps a generation alive and replayable when the client's connection drops. A thorough-mode
// answer can take minutes; without this, a brief network blip discards work that is already
// half-finished, because the SSE response is the only place the text exists.
//
// Every SSE payload is recorded in order, so a reconnecting client asks for everything after
// the last event it saw. The run is abandoned only if nobody comes back within the grace
// period — the generation itself is bound to `controller`, not to the HTTP request.

/** How long a generation keeps running after the client disappears. */
const GRACE_MS = parseInt(process.env.STREAM_RESUME_GRACE_MS ?? '90000', 10)
/** How long a finished run stays replayable, for a client that reconnects just after the end. */
const FINISHED_TTL_MS = 2 * 60 * 1000
const MAX_RUNS = 200

export interface LiveRun {
  sessionId: string
  userId: string
  /** Serialized SSE payloads, in emission order. Index + 1 is the SSE event id. */
  events: string[]
  done: boolean
  controller: AbortController
  updatedAt: number
  graceTimer?: ReturnType<typeof setTimeout>
  cleanupTimer?: ReturnType<typeof setTimeout>
  /** Resolvers for readers parked on `waitForEvents`. */
  waiters: Array<() => void>
}

const runs = new Map<string, LiveRun>()

function sweep(): void {
  const now = Date.now()
  for (const [id, run] of runs) {
    if (run.done && now - run.updatedAt > FINISHED_TTL_MS) runs.delete(id)
  }
  if (runs.size >= MAX_RUNS) {
    // Oldest-first eviction; a dropped run simply becomes unresumable.
    const byAge = [...runs.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [id] of byAge.slice(0, Math.ceil(MAX_RUNS / 4))) runs.delete(id)
  }
}

export function startRun(sessionId: string, userId: string): LiveRun {
  sweep()
  // A new generation for the same session supersedes any previous one (e.g. regenerate).
  const previous = runs.get(sessionId)
  if (previous && !previous.done) abandonRun(previous)
  const run: LiveRun = {
    sessionId, userId, events: [], done: false,
    controller: new AbortController(), updatedAt: Date.now(), waiters: [],
  }
  runs.set(sessionId, run)
  return run
}

export function getRun(sessionId: string): LiveRun | undefined {
  return runs.get(sessionId)
}

/** Records a payload and returns its SSE event id (1-based). */
export function appendEvent(run: LiveRun, data: string): number {
  run.events.push(data)
  run.updatedAt = Date.now()
  wake(run)
  return run.events.length
}

export function finishRun(run: LiveRun): void {
  run.done = true
  run.updatedAt = Date.now()
  if (run.graceTimer) clearTimeout(run.graceTimer)
  wake(run)
  run.cleanupTimer = setTimeout(() => runs.delete(run.sessionId), FINISHED_TTL_MS)
  run.cleanupTimer.unref?.()
}

function wake(run: LiveRun): void {
  const waiters = run.waiters.splice(0)
  for (const resolve of waiters) resolve()
}

/** Resolves once more events exist beyond `haveCount`, or the run ends. */
export function waitForEvents(run: LiveRun, haveCount: number, timeoutMs: number): Promise<void> {
  if (run.done || run.events.length > haveCount) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      run.waiters = run.waiters.filter(w => w !== onEvent)
      resolve()
    }, timeoutMs)
    const onEvent = () => { clearTimeout(timer); resolve() }
    run.waiters.push(onEvent)
  })
}

/** Client is gone: keep generating, but not forever. */
export function scheduleAbandon(run: LiveRun): void {
  if (run.done || run.graceTimer) return
  run.graceTimer = setTimeout(() => {
    if (run.done) return
    console.log(`  [stream] no client returned within ${GRACE_MS}ms — abandoning run for session ${run.sessionId}`)
    abandonRun(run)
  }, GRACE_MS)
  run.graceTimer.unref?.()
}

/** Client came back: cancel the pending abandon. */
export function cancelAbandon(run: LiveRun): void {
  if (!run.graceTimer) return
  clearTimeout(run.graceTimer)
  run.graceTimer = undefined
}

function abandonRun(run: LiveRun): void {
  run.controller.abort()
  finishRun(run)
}

/** Explicit stop from the user. Returns false when there is nothing running to stop. */
export function stopRun(sessionId: string, userId: string): boolean {
  const run = runs.get(sessionId)
  if (!run || run.userId !== userId || run.done) return false
  console.log(`  [stream] stopped by user — session ${sessionId}`)
  abandonRun(run)
  return true
}
