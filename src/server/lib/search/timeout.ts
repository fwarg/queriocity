/** Per-request timeout shared by the networked providers. SearXNG aggregates many engines, so it
 *  allows well over a single engine's latency — but never waits indefinitely: without it a wedged
 *  instance hangs the whole chat request. Read per call, like the rest of the search env. */
export const SEARCH_TIMEOUT_MS = () => parseInt(process.env.SEARCH_TIMEOUT_MS ?? '20000', 10)
