/** Heuristic screening of the two model-controlled outbound channels: the URL `fetch_url` asks for
 *  and the text `web_search` sends.
 *
 *  Both can carry data out. A model that has read an uploaded document — whether maliciously
 *  trained, or simply following an instruction planted in that document — can encode context into
 *  a URL query string or a search query, and `url-guard.ts` will not object: that guard blocks the
 *  *inward* direction (loopback, RFC1918, cloud metadata), which is a different attack.
 *
 *  **This raises the cost of exfiltration; it does not close it.** Every signal below keys on
 *  payload *shape*, so an attacker who knows the filter exists can leak slowly in short,
 *  natural-language-looking fragments and score zero. Treat a clean verdict as "nothing obvious",
 *  never as "safe". The only channel actually closed anywhere in this codebase is the markdown
 *  image one, by the Content-Security-Policy in index.ts.
 *
 *  Scoring rather than a boolean, because no single signal is decisive and the cost of a false
 *  positive (a blocked legitimate search) is real. */

import { queryTerms } from './query-terms.ts'

export type EgressAction = 'allow' | 'prompt' | 'block'
export type EgressMode = 'enforce' | 'log' | 'off'

export interface EgressVerdict {
  action: EgressAction
  score: number
  /** Human-readable, shown to the user in the approval prompt and written to the log. */
  reasons: string[]
}

/** What the current turn has legitimately seen, used to tell invented traffic from derived traffic. */
export interface EgressContext {
  /** Normalized origin+path of URLs that reached the model through a search result, the user's
   *  own message, or a page already fetched. */
  seenUrls: Set<string>
  seenHosts: Set<string>
  /** Content words from untrusted material (uploads, fetched pages) — the things that must not leave. */
  taintTokens: Set<string>
  /** Content words the user typed themselves. Never suspicious: the user asking about a term in
   *  their own document is the normal case, and without this every on-topic search would score. */
  userTokens: Set<string>
}

/** `enforce` acts on verdicts; `log` scores and reports but always allows, which is the mode to run
 *  while calibrating thresholds against real traffic; `off` skips the work entirely.
 *
 *  Read per call rather than captured at import: a module-level constant freezes whatever the
 *  environment held when the module was first loaded, which makes the mode untestable and is the
 *  same import-order trap documented in test-support/test-env.ts. The cost is a string compare. */
export function egressMode(): EgressMode {
  const raw = process.env.EGRESS_GUARD?.trim().toLowerCase()
  return (['enforce', 'log', 'off'] as const).find(m => m === raw) ?? 'enforce'
}

const PROMPT_SCORE = 3
const BLOCK_SCORE = 6

// Tokens shorter than this are too common to indicate that document content is leaving.
const MIN_TAINT_TOKEN = 4
// Below this length a string has too few characters for an entropy estimate to mean anything.
const MIN_ENTROPY_SAMPLE = 20

export function createEgressContext(): EgressContext {
  return { seenUrls: new Set(), seenHosts: new Set(), taintTokens: new Set(), userTokens: new Set() }
}

/** Origin + path, lowercased, query and fragment dropped.
 *
 *  Dropping the query is what lets `?page=2` match the page it paginates — `fetch_url` advertises
 *  pagination, so requiring an exact match would flag ordinary use. The query is still scored
 *  separately, so appending a payload to a URL that was seen gains nothing. */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return null
  }
}

export function noteSeenUrl(ctx: EgressContext, raw: string): void {
  const norm = normalizeUrl(raw)
  if (!norm) return
  ctx.seenUrls.add(norm)
  try { ctx.seenHosts.add(new URL(raw).hostname.toLowerCase()) } catch { /* already normalized above */ }
}

const addTokens = (into: Set<string>, text: string) => {
  for (const t of queryTerms(text)) if (t.length >= MIN_TAINT_TOKEN) into.add(t)
}

/** Record content that arrived from an untrusted source — an uploaded document or a fetched page. */
export function noteTaint(ctx: EgressContext, text: string): void {
  addTokens(ctx.taintTokens, text)
}

export function noteUserText(ctx: EgressContext, text: string): void {
  addTokens(ctx.userTokens, text)
}

/** Shannon entropy in bits per character.
 *
 *  Deliberately a weak, corroborating signal only. The textbook figures (prose ~4, base64 ~6)
 *  describe long samples; at the length of a real query string they converge badly — measured here,
 *  a 46-character base64 blob scores 4.47 against 4.2 for ordinary prose. Entropy is capped by
 *  log2(sample length), so short payloads cannot reach the values the theory promises. The
 *  structural checks below do the real work. */
export function entropy(s: string): number {
  if (!s) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of freq.values()) {
    const p = n / s.length
    bits -= p * Math.log2(p)
  }
  return bits
}

// `/` is deliberately absent despite being a base64 character: it is also the path separator, so
// including it let a run span segments and turned `/world/2026/aug/09/eu-ai-act-…` into a match on
// lowercase-plus-digits. A payload using standard base64 in a URL has to percent-encode its
// slashes anyway, which the escape-density check below catches instead.
const LONG_RUN = /[A-Za-z0-9+=_-]{32,}/g

/** True when the text holds a 32+ character unbroken run that mixes character classes.
 *
 *  The length alone is not enough, and assuming otherwise was the first version's bug: a URL slug
 *  like `eu-ai-act-transparency-rules-come-into-force` is a 44-character unbroken run under any
 *  character class that includes the hyphen, and flagging it would fire on ordinary news links.
 *  Requiring two of {lowercase, uppercase, digit} keeps slugs out — they are lowercase and hyphens
 *  only — while base64 (all three) and hex (lowercase plus digits) still match. */
function hasEncodedRun(text: string): boolean {
  for (const [run] of text.matchAll(LONG_RUN)) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter(re => re.test(run)).length
    if (classes >= 2) return true
  }
  return false
}

/** Signals shared by URLs and search queries: how much room the text has for a payload, and
 *  whether any of it looks like the output of an encoder rather than something a person wrote.
 *
 *  `encoded` is reported separately because callers weigh it differently — see `inspectQuery`. */
function scoreCarrier(text: string, softCap: number): { score: number; reasons: string[]; encoded: boolean } {
  const reasons: string[] = []
  let score = 0

  if (text.length > softCap * 2) {
    score += 2
    reasons.push(`unusually long (${text.length} chars)`)
  } else if (text.length > softCap) {
    score += 1
    reasons.push(`long (${text.length} chars)`)
  }

  // A mixed-class unbroken token of this length is the most reliable signal available: written
  // language has no such words, and it is what every encoder produces.
  const encoded = hasEncodedRun(text)
  if (encoded) {
    score += 4
    reasons.push('contains an unbroken 32+ character encoded-looking run')
  }

  const escapes = (text.match(/%[0-9a-f]{2}/gi) ?? []).length * 3
  if (text.length && escapes / text.length > 0.2) {
    score += 2
    reasons.push('heavily percent-encoded')
  }

  if (text.length >= MIN_ENTROPY_SAMPLE) {
    const bits = entropy(text)
    if (bits > 4.8) {
      score += 1
      reasons.push(`high entropy (${bits.toFixed(1)} bits/char)`)
    }
  }

  return { score, reasons, encoded }
}

/** Content words that came from untrusted material and that the user never typed. The sharpest
 *  signal available: it asks "is document content leaving?" rather than guessing at payload shape,
 *  and it is the one an attacker cannot avoid while still exfiltrating anything meaningful. */
function scoreTaint(text: string, ctx: EgressContext): { score: number; reasons: string[] } {
  if (!ctx.taintTokens.size) return { score: 0, reasons: [] }
  const hits: string[] = []
  for (const t of queryTerms(text)) {
    if (t.length >= MIN_TAINT_TOKEN && ctx.taintTokens.has(t) && !ctx.userTokens.has(t)) hits.push(t)
  }
  if (!hits.length) return { score: 0, reasons: [] }
  const shown = hits.slice(0, 5).join(', ')
  return hits.length >= 2
    ? { score: 6, reasons: [`carries ${hits.length} terms from documents the user did not mention (${shown})`] }
    : { score: 3, reasons: [`carries a term from a document the user did not mention (${shown})`] }
}

function verdict(score: number, reasons: string[]): EgressVerdict {
  const bounded = Math.max(0, score)
  const action: EgressAction =
    bounded >= BLOCK_SCORE ? 'block' : bounded >= PROMPT_SCORE ? 'prompt' : 'allow'
  return { action, score: bounded, reasons }
}

/** Host-level signals: an invented destination, or a hostname being used as the payload itself. */
function scoreHost(u: URL, ctx: EgressContext): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  const host = u.hostname.toLowerCase()

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    score += 2
    reasons.push('destination is a bare IP address')
  }
  if (host.startsWith('xn--') || host.includes('.xn--')) {
    score += 2
    reasons.push('punycode hostname')
  }
  if (host.split('.').some(label => label.length > 40)) {
    score += 3
    reasons.push('hostname label long enough to carry data')
  }
  if (ctx.seenHosts.size && !ctx.seenHosts.has(host)) {
    score += 2
    reasons.push('host did not appear in search results or the conversation')
  }
  return { score, reasons }
}

/** Screen a URL the model wants to fetch. */
export function inspectUrl(raw: string, ctx: EgressContext): EgressVerdict {
  let u: URL
  try { u = new URL(raw) } catch { return verdict(BLOCK_SCORE, ['malformed URL']) }

  // The hostname is scored as a carrier too: putting the payload in a subdomain label is a
  // standard exfiltration trick, and it never reaches the path.
  const carrier = scoreCarrier(`${u.hostname}${u.pathname}${u.search}${u.hash}`, 120)
  // Taint is matched against the payload-carrying parts only. Including the hostname produced a
  // false positive on every link to a domain whose name also appears in the document — a document
  // mentioning an @something.example address made every fetch of *.example look like a leak.
  const taint = scoreTaint(decodeSafely(`${u.pathname}${u.search}${u.hash}`), ctx)
  const host = scoreHost(u, ctx)

  // Provenance discounts the *host* signals only. A seen origin and path says nothing about what
  // was appended to the query string, so it must not offset an encoded payload found there.
  let hostScore = host.score
  const reasons = [...carrier.reasons, ...taint.reasons, ...host.reasons]
  if (ctx.seenUrls.has(normalizeUrl(raw) ?? '')) {
    hostScore = 0
    reasons.push('(origin and path were seen in this conversation)')
  }
  return verdict(carrier.score + taint.score + hostScore, reasons)
}

/** Screen the text of a web search. No host to judge, so this rests on carrier shape and taint. */
export function inspectQuery(query: string, ctx: EgressContext): EgressVerdict {
  const carrier = scoreCarrier(query, 150)
  const taint = scoreTaint(query, ctx)
  // Weighed harder than in a URL, and this is the one asymmetry worth having: URLs legitimately
  // carry long opaque tokens (presigned links, JWTs, media ids), so an encoded run there is only
  // worth a prompt. A *search query* has no such excuse — nobody searches for a base64 blob.
  const encoded = carrier.encoded ? 2 : 0
  return verdict(carrier.score + taint.score + encoded, carrier.reasons.concat(taint.reasons))
}

/** Percent-decoding must not throw on a malformed sequence — screening runs on hostile input. */
function decodeSafely(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/** The verdict to act on, after `EGRESS_GUARD`. Logging happens here so every call site reports
 *  identically and `log` mode produces the data needed to tune the thresholds. */
export function applyEgressMode(v: EgressVerdict, kind: 'fetch' | 'search', target: string): EgressVerdict {
  const mode = egressMode()
  if (mode === 'off') return { ...v, action: 'allow' }
  if (v.action === 'allow') return v
  const summary = `${kind} score=${v.score} → ${v.action}: ${v.reasons.join('; ')} — ${target.slice(0, 200)}`
  if (mode === 'log') {
    console.warn(`  [egress] would ${v.action} (log mode) ${summary}`)
    return { ...v, action: 'allow' }
  }
  console.warn(`  [egress] ${summary}`)
  return v
}
