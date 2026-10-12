/** A fake SearXNG for pipeline tests, plus a compact view of an SSE event stream. */

/** One parsed SSE payload. */
export type SseEvent = { type: string; [k: string]: unknown }

/** Serves `count` numbered results, one per host so per-domain dedup keeps them all, for every query; records the queries asked. */
export function startFakeSearxng(count = 3) {
  const queries: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      queries.push(new URL(req.url).searchParams.get('q') ?? '')
      const results = Array.from({ length: count }, (_, i) => ({
        title: `Result ${i + 1}`,
        url: `https://site${i + 1}.example.com/page`,
        content: `Snippet about result ${i + 1}.`,
        engine: 'stub',
      }))
      return Response.json({ results })
    },
  })
  return { url: `http://localhost:${server.port}`, queries, stop: () => server.stop(true) }
}

/** Event types in order, steps as `step:<kind>`, with repeats of the same entry collapsed, so a
 *  test pins the order without depending on how the text happened to be chunked. */
export function signature(events: SseEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.type === 'ping') continue
    const step = e.step as { kind?: string } | undefined
    const name = step?.kind ? `step:${step.kind}` : e.type
    if (out.at(-1) !== name) out.push(name)
  }
  return out
}
