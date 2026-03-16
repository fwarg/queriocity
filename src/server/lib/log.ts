/** Timed call helper — logs label, target, and elapsed ms. */
export async function timed<T>(label: string, target: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    const result = await fn()
    const ms = (performance.now() - start).toFixed(0)
    console.log(`  [${label}] ${target} — ${ms}ms`)
    return result
  } catch (err) {
    const ms = (performance.now() - start).toFixed(0)
    console.error(`  [${label}] ${target} — ${ms}ms ERROR: ${err}`)
    throw err
  }
}
