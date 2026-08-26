/** A minimal OpenAI-compatible embeddings server for tests.
 *
 *  The alternative is `mock.module('./embeddings.ts', …)`, which is process-wide, outlives the file
 *  that installs it and cannot be undone — see env-override.ts for the CI failure that cost. A real
 *  server behind EMBED_BASE_URL is stubbed the same way the chat model already is.
 *
 *  Vectors are derived from the text rather than constant, so two different chunks are genuinely
 *  different points and a nearest-neighbour search returns something meaningful. */
export function startFakeEmbeddings(dims: number) {
  const requests: unknown[] = []
  /** Set to make every call fail. A 400 rather than a dead port or a 500: the AI SDK does not retry
   *  it, so a test for the failure path finishes immediately instead of sitting through backoff. */
  const state = { failing: false }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith('/embeddings')) return new Response('not found', { status: 404 })
      const body = await req.json().catch(() => null) as { input?: string | string[] } | null
      requests.push(body)
      if (state.failing) return Response.json({ error: { message: 'embedding stub is failing' } }, { status: 400 })

      const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? '']
      return Response.json({
        object: 'list',
        model: 'fake-embed',
        data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(String(text), dims) })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      })
    },
  })

  return {
    baseURL: `http://localhost:${server.port}/v1`,
    requests,
    /** Runs `fn` with every embedding call failing, restoring the server afterwards either way. */
    async whileFailing<T>(fn: () => Promise<T>): Promise<T> {
      state.failing = true
      try { return await fn() } finally { state.failing = false }
    },
    stop: () => server.stop(true),
  }
}

/** A unit vector whose direction follows the words in the text, so texts sharing words land near
 *  each other and unrelated ones do not. Enough structure for a retrieval assertion, no model. */
function vectorFor(text: string, dims: number): number[] {
  const vector = Array(dims).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9åäö]+/g) ?? []) {
    let hash = 0
    for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
    vector[hash % dims] += 1
  }
  const length = Math.hypot(...vector) || 1
  return vector.map(v => v / length)
}
