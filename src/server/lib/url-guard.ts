import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// Escape hatch for deployments that legitimately fetch internal pages (e.g. an intranet wiki).
const ALLOW_PRIVATE = process.env.FETCH_ALLOW_PRIVATE_HOSTS === 'true'
if (ALLOW_PRIVATE) {
  console.warn('[url-guard] FETCH_ALLOW_PRIVATE_HOSTS=true — URL fetching may reach loopback, LAN and cloud-metadata addresses. Any URL the model is told to fetch (including one planted in a web page it reads) can hit internal services.')
}

const INTERNAL_HOST_SUFFIXES = ['.localhost', '.internal', '.local']
const MAX_CACHED_HOSTS = 1000
const HOST_CACHE_TTL_MS = 60_000

/** Thrown when a URL is refused before any network request is made. */
export class BlockedUrlError extends Error {}

/** Verdict cache keyed by hostname — Playwright re-checks every navigation, and a page
 *  redirect chain can hit the same host repeatedly, so avoid a DNS lookup each time. */
const hostVerdicts = new Map<string, { blocked: string | null; ts: number }>()

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return true          // unspecified, RFC1918, loopback
  if (a === 169 && b === 254) return true                    // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true           // RFC1918
  if (a === 192 && b === 168) return true                    // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true          // CGNAT
  if (a >= 224) return true                                  // multicast + reserved
  return false
}

function isBlockedV6(ip: string): boolean {
  const a = ip.toLowerCase()
  if (a === '::' || a === '::1') return true                 // unspecified, loopback
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)    // IPv4-mapped
  if (mapped) return isBlockedV4(mapped[1])
  if (/^fe[89ab]/.test(a)) return true                       // fe80::/10 link-local
  if (/^f[cd]/.test(a)) return true                          // fc00::/7 unique-local
  if (a.startsWith('ff')) return true                        // multicast
  return false
}

/** True for addresses a fetched URL must never reach. Unparseable input is refused. */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isBlockedV4(ip)
  if (version === 6) return isBlockedV6(ip)
  return true
}

async function hostVerdict(host: string): Promise<string | null> {
  const now = Date.now()
  const hit = hostVerdicts.get(host)
  if (hit && now - hit.ts < HOST_CACHE_TTL_MS) return hit.blocked

  let blocked: string | null = null
  if (host === 'localhost' || INTERNAL_HOST_SUFFIXES.some(s => host.endsWith(s))) {
    blocked = `host ${host} is internal`
  } else if (isIP(host)) {
    if (isBlockedAddress(host)) blocked = `address ${host} is loopback, private or link-local`
  } else {
    try {
      const addrs = await lookup(host, { all: true })
      const bad = addrs.find(a => isBlockedAddress(a.address))
      if (bad) blocked = `host ${host} resolves to internal address ${bad.address}`
    } catch {
      blocked = `host ${host} could not be resolved`
    }
  }

  if (hostVerdicts.size >= MAX_CACHED_HOSTS) hostVerdicts.clear()
  hostVerdicts.set(host, { blocked, ts: now })
  return blocked
}

/** Refuses URLs that could reach the host, the Docker/LAN network, or cloud metadata.
 *  Resolves DNS so a public hostname pointing at a private address is caught too, and must be
 *  re-run on every redirect hop — a single check on the original URL is bypassed by a 302.
 *  With FETCH_PROXY_URL set the proxy does its own resolution, so the lookup here is a
 *  pre-check rather than a guarantee. Bypassed entirely by FETCH_ALLOW_PRIVATE_HOSTS=true. */
export async function assertFetchableUrl(raw: string): Promise<void> {
  let u: URL
  try { u = new URL(raw) } catch { throw new BlockedUrlError('malformed URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme "${u.protocol}" is not allowed (only http and https)`)
  }
  if (ALLOW_PRIVATE) return
  const blocked = await hostVerdict(u.hostname.replace(/^\[|\]$/g, '').toLowerCase())
  if (blocked) throw new BlockedUrlError(blocked)
}
