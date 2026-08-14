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

/** How long an egress approval waits for the user before it is refused. */
export const APPROVAL_TIMEOUT_MS = parseInt(process.env.EGRESS_APPROVAL_TIMEOUT_MS ?? '60000', 10)

interface PendingApproval {
  decide: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
  /** So a client that reconnects mid-decision is told how long is actually left, rather than
   *  being shown a fresh countdown against a timer that has been running the whole time. */
  expiresAt: number
}

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
  /** Outbound requests parked waiting on the user, keyed by approval id. */
  approvals: Map<string, PendingApproval>
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
    approvals: new Map(),
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

/** `ttlMs` is a parameter rather than read straight from the constant so the eviction path can be
 *  tested without a two-minute wait, exactly as `awaitApproval` takes its timeout. */
export function finishRun(run: LiveRun, ttlMs = FINISHED_TTL_MS): void {
  run.done = true
  run.updatedAt = Date.now()
  if (run.graceTimer) clearTimeout(run.graceTimer)
  // Anything still parked can never be answered now, and every path out of an approval must
  // resolve it — an unresolved one leaves the generation awaiting a promise forever.
  for (const id of [...run.approvals.keys()]) settleApproval(run, id, false)
  wake(run)
  // Delete this run, not whatever holds the id by then: a next turn on the same session replaces
  // the map entry well inside the TTL, and an unconditional delete would evict a live generation —
  // after which resume 404s, stop reports nothing to stop, and approvals cannot be answered.
  run.cleanupTimer = setTimeout(() => {
    if (runs.get(run.sessionId) === run) runs.delete(run.sessionId)
  }, ttlMs)
  run.cleanupTimer.unref?.()
}

/** Parks an outbound request until the user answers, the timeout expires, or the run ends.
 *
 *  Refusal is the default for every one of those, so a user who closes the tab, loses their
 *  connection, or simply ignores the prompt does not thereby permit the request.
 *
 *  `timeoutMs` is a parameter rather than read straight from the constant so the expiry path can
 *  be tested without a 60-second wait. */
export function awaitApproval(run: LiveRun, id: string, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      console.warn(`  [egress] approval ${id} timed out after ${timeoutMs}ms — refused`)
      settleApproval(run, id, false)
    }, timeoutMs)
    timer.unref?.()
    run.approvals.set(id, { decide: resolve, timer, expiresAt: Date.now() + timeoutMs })
  })
}

/** Resolves a parked approval. Returns false when there was nothing waiting under that id. */
export function settleApproval(run: LiveRun, id: string, allow: boolean): boolean {
  const pending = run.approvals.get(id)
  if (!pending) return false
  clearTimeout(pending.timer)
  run.approvals.delete(id)
  pending.decide(allow)
  return true
}

/** Milliseconds left on a parked approval, for a client that reconnected mid-decision. */
export function approvalTimeLeft(run: LiveRun, id: string): number | null {
  const pending = run.approvals.get(id)
  return pending ? Math.max(0, pending.expiresAt - Date.now()) : null
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
