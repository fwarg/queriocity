import { createHash } from 'crypto'

const TTL = 5 * 60 * 1000 // 5 minutes

interface Entry<T> {
  result: T
  expires: number
}

const store = new Map<string, Entry<unknown>>()
const MAX_ENTRIES = 500

// Turns of conversation folded into the key alongside the question. Enough to separate two
// discussions that happen to end in the same words; short enough that it is still the *question*
// being keyed, not the entire session.
const HISTORY_TURNS = 4

/** `scope` must capture everything that personalises an answer (user, space, custom prompt,
 *  pinned resources) — without it a cached reply can be served to a different user.
 *
 *  `history` is required for the same reason: keyed on the last message alone, two unrelated
 *  conversations that both end in "Is it officially shut down?" collide, and the second is served
 *  the first's answer. Pass the preceding turns; the last `HISTORY_TURNS` of them are hashed in. */
export function cacheKey(query: string, focusMode: string, scope: string, history: Array<{ role: string; content: string }> = []): string {
  const context = history.slice(-HISTORY_TURNS).map(m => `${m.role}:${m.content}`).join('\n')
  return createHash('sha256').update(`${focusMode}:${scope}:${context}:${query}`).digest('hex')
}

export function getCached<T>(key: string): T | null {
  const entry = store.get(key) as Entry<T> | undefined
  if (!entry || Date.now() > entry.expires) {
    store.delete(key)
    return null
  }
  return entry.result
}

export function setCached<T>(key: string, result: T): void {
  const now = Date.now()
  if (store.size >= MAX_ENTRIES) {
    for (const [k, e] of store) if (now > e.expires) store.delete(k)
    if (store.size >= MAX_ENTRIES) store.clear()
  }
  store.set(key, { result, expires: now + TTL })
}
