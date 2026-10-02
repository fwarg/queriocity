/** Merging provider rankings into one result list: the original rules ("legacy") and weighted
 *  Reciprocal Rank Fusion. Pure functions over finished provider runs; nothing here does I/O. */

import { engineWeight, type ProviderPolicy } from './policy.ts'
import type { ProviderResult, SearchProvider, SearchResult } from './types.ts'

/** A provider's finished search, with the policy it ran under. */
export interface ProviderRun {
  provider: SearchProvider
  policy: ProviderPolicy
  results: ProviderResult[]
}

/** A `site:`-scoped query deliberately asks for one domain, so per-domain dedup would discard
 *  everything but the first hit — turning 8 articles from the requested site into 1. */
export function isSiteScoped(query: string): boolean {
  return /\bsite:\S/i.test(query)
}

const domainOf = (url: string): string | null => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null }
}

/** Drop results sharing a hostname (ignoring leading www.), keeping the first occurrence. */
export function dedupeByDomain<T extends SearchResult>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter(r => {
    const domain = domainOf(r.url)
    if (domain === null) return true
    if (seen.has(domain)) return false
    seen.add(domain)
    return true
  })
}

/** Concatenate result batches, keeping the first occurrence of each URL. */
export function mergeBatches<T extends SearchResult>(batches: T[][]): T[] {
  const seen = new Set<string>()
  return batches.flat().filter(r => {
    if (seen.has(r.url)) return false
    seen.add(r.url)
    return true
  })
}

/** Page identity across sources that spell URLs differently: ignores scheme, www., trailing slash and fragment. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + u.search
  } catch {
    return url
  }
}

/** Drop provider-internal fields so only the SearchResult shape reaches the model. */
export const plain = ({ title, url, content }: SearchResult): SearchResult => ({ title, url, content })

/** Interleave supplement hits with the other results.
 *
 *  Supplements have slots of their own instead of competing for `count`, so neither source is
 *  sliced away to make room; the reranker later judges all of them on equal terms. They also bypass
 *  dedupeByDomain: two passages from one small site are signal, not the duplication dedup exists
 *  for. Where both returned the same page the supplement's copy is kept, since its passage was
 *  chosen for this query. */
export function interleaveSupplements(results: SearchResult[], supplements: SearchResult[][]): SearchResult[] {
  const extra = supplements.filter(s => s.length)
  if (!extra.length) return results
  const covered = new Set(extra.flat().map(r => pageKey(r.url)))
  const lists = [results.filter(r => !covered.has(pageKey(r.url))), ...extra]
  const merged: SearchResult[] = []
  for (let i = 0; i < Math.max(...lists.map(l => l.length)); i++) {
    for (const l of lists) if (i < l.length) merged.push(l[i])
  }
  return merged
}

/** The primaries' results in provider order, deduplicated by domain (unless site-scoped), cut to `count`. */
export function mergePrimaries(query: string, count: number, primaries: ProviderRun[]): SearchResult[] {
  const merged = mergeBatches(primaries.map(r => r.results.map(plain)))
  return (isSiteScoped(query) ? merged : dedupeByDomain(merged)).slice(0, count)
}

/** Add a fallback's results to the primaries'. When the primaries already filled the page from
 *  niche engines alone, the fallback goes first — appended, it would be sliced away again, and
 *  getting past those engines is the reason it was called. */
export function mergeFallback(query: string, count: number, base: SearchResult[], fallback: SearchResult[], fallbackFirst: boolean): SearchResult[] {
  const combined = fallbackFirst ? [...fallback, ...base] : [...base, ...fallback]
  return (isSiteScoped(query) ? combined : dedupeByDomain(combined)).slice(0, count)
}

interface Scored {
  key: string
  result: ProviderResult
  score: number
  /** The copy's own contribution, to pick which provider's title and snippet represent the page. */
  best: number
  /** Kept from a provider whose hits are query-chosen passages: wins the copy, skips domain dedup. */
  passage: boolean
  providers: Set<string>
}

/** One run's contribution per hit: provider weight × best sub-engine weight / (k + rank). */
function contributions(run: ProviderRun, k: number) {
  return run.results.map((r, i) => {
    const ew = r.engines?.length ? Math.max(...r.engines.map(e => engineWeight(run.policy, e))) : 1
    return { r, c: run.policy.weight * ew / (k + i + 1) }
  })
}

function scorePages(runs: ProviderRun[], k: number): Scored[] {
  const pages = new Map<string, Scored>()
  for (const run of runs) {
    const passage = !!run.provider.passageHits
    for (const { r, c } of contributions(run, k)) {
      const key = pageKey(r.url)
      const page = pages.get(key)
      if (!page) {
        pages.set(key, { key, result: r, score: c, best: c, passage, providers: new Set([run.provider.id]) })
        continue
      }
      page.score += c
      page.providers.add(run.provider.id)
      if ((passage && !page.passage) || (passage === page.passage && c > page.best)) {
        Object.assign(page, { result: r, best: c, passage })
      }
    }
  }
  return [...pages.values()].sort((a, b) => b.score - a.score)
}

/** Weighted Reciprocal Rank Fusion over every run.
 *
 *  Ranks only, never provider scores — none of ours are comparable. A page several providers
 *  return accumulates score, so agreement lifts it. Each provider's `minSlots` best pages are
 *  reserved first (the guarantee spejaren had under the legacy merge), then the rest of `total`
 *  is filled by score. */
export function rrfFuse(query: string, total: number, runs: ProviderRun[], k: number): SearchResult[] {
  const ranked = scorePages(runs, k)
  const siteScoped = isSiteScoped(query)
  const seenDomains = new Set<string>()
  const candidates = ranked.filter(p => {
    if (siteScoped || p.passage) return true
    const d = domainOf(p.result.url)
    if (d === null) return true
    if (seenDomains.has(d)) return false
    seenDomains.add(d)
    return true
  })

  const chosen = new Set<Scored>()
  for (const run of runs) {
    const mine = candidates.filter(p => p.providers.has(run.provider.id))
    for (const p of mine.slice(0, Math.min(run.policy.minSlots, total))) chosen.add(p)
  }
  for (const p of candidates) {
    if (chosen.size >= total) break
    chosen.add(p)
  }
  return candidates.filter(p => chosen.has(p)).map(p => plain(p.result))
}
