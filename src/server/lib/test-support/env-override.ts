/** Points a test at a stub by overriding `process.env`, returning the undo.
 *
 *  Preferred over `mock.module` for anything `lib/llm.ts` resolves per call — every provider it
 *  builds reads its base URL, key and model name at call time for exactly this reason. A module
 *  mock is process-wide, outlives the file that installed it, and cannot be undone: mocking
 *  mutates the live namespace object in place, so a captured "real" module has already become
 *  the mock and restoring from it puts the mock back. Every file running afterwards then talks
 *  to a server the mocking file has already stopped, which surfaces as an unattributable timeout.
 *
 *  Undo in `afterAll`: bun runs every test file in one process, so an override left behind leaks
 *  the same way, just more visibly. */
export function envOverride(vars: Record<string, string>): () => void {
  const saved = Object.keys(vars).map(k => [k, process.env[k]] as const)
  Object.assign(process.env, vars)
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
