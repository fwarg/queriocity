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
  if (a === 198 && (b === 18 || b === 19)) return true       // benchmarking
  if (a === 192 && b === 0 && ip.split('.')[2] === '0') return true  // IETF protocol assignments
  if (a >= 224) return true                                  // multicast + reserved
  return false
}

/** The eight 16-bit groups of a valid v6 address, with a trailing dotted v4 folded into the last two. */
function v6Groups(ip: string): number[] {
  let s = ip.toLowerCase()
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (dotted) {
    const [p, q, r, t] = dotted.slice(1).map(Number)
    s = s.slice(0, dotted.index) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const parse = (part: string | undefined) => part ? part.split(':').map(h => parseInt(h, 16)) : []
  const hi = parse(head), lo = parse(tail)
  return [...hi, ...Array(8 - hi.length - lo.length).fill(0), ...lo]
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/** Checks the hex form too: URL parsing turns `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`. */
function isBlockedV6(ip: string): boolean {
  const g = v6Groups(ip)
  const zeroPrefix = (n: number) => g.slice(0, n).every(x => x === 0)
  if (zeroPrefix(6)) return isBlockedV4(v4Of(g[6], g[7]))   // ::, ::1, IPv4-compatible
  if (zeroPrefix(5) && g[5] === 0xffff) return isBlockedV4(v4Of(g[6], g[7]))  // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isBlockedV4(v4Of(g[6], g[7]))  // NAT64
  if (g[0] === 0x2002) return isBlockedV4(v4Of(g[1], g[2]))  // 6to4
  if ((g[0] & 0xffc0) === 0xfe80) return true                // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true                // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true                // multicast
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
