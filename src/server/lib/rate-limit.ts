import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from 'hono/bun'
import type { AppEnv } from '../middleware/auth.ts'

// Only trust X-Forwarded-For when a reverse proxy is known to set it. Without this, any
// client can forge the header and get its own rate-limit bucket per request.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true'
const MAX_TRACKED_KEYS = 10_000

interface Window { count: number; resetAt: number }

/** Fixed-window in-memory rate limiter. Per-process — adequate for a single-instance deployment. */
export class RateLimiter {
  private windows = new Map<string, Window>()

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Records a hit; returns false once the key has exhausted its allowance for this window. */
  check(key: string): boolean {
    if (this.limit <= 0) return true
    const now = Date.now()
    if (this.windows.size >= MAX_TRACKED_KEYS) this.sweep(now)
    const w = this.windows.get(key)
    if (!w || w.resetAt < now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (w.count >= this.limit) return false
    w.count++
    return true
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (w.resetAt < now) this.windows.delete(k)
    if (this.windows.size >= MAX_TRACKED_KEYS) this.windows.clear()
  }
}

/** Client address for rate limiting. Takes the *last* X-Forwarded-For hop — the one the
 *  reverse proxy appended — since earlier entries are supplied by the client itself. */
export function clientIp(c: Context): string {
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for')
    if (xff) {
      const hops = xff.split(',').map(s => s.trim()).filter(Boolean)
      if (hops.length) return hops[hops.length - 1]
    }
    const real = c.req.header('x-real-ip')
    if (real) return real.trim()
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Warns once at startup if forwarded headers are arriving but aren't trusted — that
 *  combination silently collapses every user behind the proxy into one bucket. */
export function warnIfProxyUntrusted(c: Context): void {
  if (TRUST_PROXY || warnedAboutProxy) return
  if (!c.req.header('x-forwarded-for')) return
  warnedAboutProxy = true
  console.warn('[rate-limit] X-Forwarded-For received but TRUST_PROXY is not set — rate limits are keyed on the proxy\'s address, so all users share one bucket. Set TRUST_PROXY=true when running behind nginx.')
}
let warnedAboutProxy = false

const perMinute = (envVar: string, fallback: number) =>
  new RateLimiter(parseInt(process.env[envVar] ?? String(fallback), 10), 60_000)

/** Per-user limits on the endpoints that cost real model/browser time. 0 disables a limit. */
export const chatLimiter = perMinute('RATE_LIMIT_CHAT_PER_MIN', 30)
export const suggestLimiter = perMinute('RATE_LIMIT_SUGGEST_PER_MIN', 60)
export const imageLimiter = perMinute('RATE_LIMIT_IMAGE_PER_MIN', 10)
export const ingestLimiter = perMinute('RATE_LIMIT_INGEST_PER_MIN', 10)

/** Middleware form, keyed on the authenticated user — must run after authMiddleware. */
export function rateLimitByUser(limiter: RateLimiter, label: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const userId = c.get('userId')
    if (!limiter.check(userId)) {
      console.warn(`  [rate-limit] ${label} throttled for user ${userId}`)
      return c.json({ error: 'Too many requests. Please slow down.' }, 429)
    }
    await next()
  }
}
