/** Per-provider counters since server start, for the admin panel's weight tuning. In memory only:
 *  they describe this process's traffic, and a restart starting from zero is acceptable for that. */

export interface ProviderStats {
  calls: number
  failures: number
  /** Hits returned, before fusion. */
  results: number
  /** Hits that made it into the fused list handed to the caller. */
  kept: number
  totalMs: number
  /** Hits per sub-engine, for a meta-engine. */
  engines: Record<string, number>
}

const stats = new Map<string, ProviderStats>()

function entry(id: string): ProviderStats {
  let s = stats.get(id)
  if (!s) stats.set(id, s = { calls: 0, failures: 0, results: 0, kept: 0, totalMs: 0, engines: {} })
  return s
}

export function recordCall(id: string, ms: number, failed: boolean, results: Array<{ engines?: string[] }>): void {
  const s = entry(id)
  s.calls++
  s.totalMs += ms
  if (failed) s.failures++
  s.results += results.length
  for (const r of results) for (const e of r.engines ?? []) s.engines[e] = (s.engines[e] ?? 0) + 1
}

export function recordKept(id: string, n: number): void {
  entry(id).kept += n
}

export function telemetrySnapshot(): Record<string, ProviderStats> {
  return Object.fromEntries([...stats].map(([id, s]) => [id, { ...s, engines: { ...s.engines } }]))
}
