import { createHash } from 'crypto'

const TTL = 5 * 60 * 1000 // 5 minutes

interface Entry<T> {
  result: T
  expires: number
}

const store = new Map<string, Entry<unknown>>()
const MAX_ENTRIES = 500

/** `scope` must capture everything that personalises an answer (user, space, custom prompt,
 *  pinned resources) — without it a cached reply can be served to a different user. */
export function cacheKey(query: string, focusMode: string, scope: string): string {
  return createHash('sha256').update(`${focusMode}:${scope}:${query}`).digest('hex')
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
