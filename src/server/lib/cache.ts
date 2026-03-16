import { createHash } from 'crypto'

const TTL = 5 * 60 * 1000 // 5 minutes

interface Entry<T> {
  result: T
  expires: number
}

const store = new Map<string, Entry<unknown>>()

export function cacheKey(query: string, focusMode: string): string {
  return createHash('sha256').update(`${focusMode}:${query}`).digest('hex')
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
  store.set(key, { result, expires: Date.now() + TTL })
}
