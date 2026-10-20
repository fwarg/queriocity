/** The web sources a memory cites: shaping, ranking and mapping them from a turn's citations. */

import { rerank, rerankEnabled } from '../reranker.ts'
import { splitGroupedCitations } from '../../../shared/citations.ts'

export interface MemorySource { url: string; title: string }

/** A candidate source before it is trimmed to the stored `{url,title}` shape: keeps the citation
 *  number and snippet so a memory's sources can be ranked by relevance to its text. */
export interface RankableSource extends MemorySource { content?: string; index?: number }

/** A fact on its way into space memory, optionally with the web sources that back it. */
export interface MemoryFact { text: string; sources?: MemorySource[] }

/** Most web sources to keep on one memory. A note backed by more than a handful of pages is worse
 *  than one backed by none — the list stops being a pointer and becomes noise. Env-overridable
 *  like the other memory tuning constants. */
export const MEMORY_MAX_SOURCES = parseInt(process.env.MEMORY_MAX_SOURCES ?? '', 10) || 5

export const slimSource = (s: MemorySource): MemorySource => ({ url: s.url, title: s.title || s.url })

export function dedupeByUrl<T extends MemorySource>(sources: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const s of sources) {
    if (!s?.url || seen.has(s.url)) continue
    seen.add(s.url)
    out.push(s)
  }
  return out
}

/** Concat source lists, drop entries without a url, dedupe by url, cap at `MEMORY_MAX_SOURCES`.
 *  `undefined` when empty so a drizzle `.set({ sources })` writes NULL rather than `[]`. Earlier
 *  lists win a tie, so on an UPDATE the incoming fact's sources are kept ahead of the old ones. */
export function unionSources(...lists: (MemorySource[] | null | undefined)[]): MemorySource[] | undefined {
  const out = dedupeByUrl(lists.flatMap(l => l ?? [])).map(slimSource).slice(0, MEMORY_MAX_SOURCES)
  return out.length ? out : undefined
}

/** Coerce a stored-source array — a turn's reference list, or the `sources` JSON on a persisted
 *  message — preserving order, citation index and snippet, and dropping anything without a url. */
export function toMemorySources(raw: unknown): RankableSource[] {
  if (!Array.isArray(raw)) return []
  const out: RankableSource[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const r = s as Record<string, unknown>
    if (typeof r.url !== 'string' || !r.url) continue
    out.push({
      url: r.url,
      title: typeof r.title === 'string' && r.title ? r.title : r.url,
      content: typeof r.content === 'string' ? r.content : undefined,
      index: typeof r.index === 'number' ? r.index : undefined,
    })
  }
  return out
}

/** Choose up to `MEMORY_MAX_SOURCES` of the turn's sources for a note that carried no `[N]` marker
 *  of its own. The reranker (when configured) scores each source against the note text; otherwise
 *  citation order — the researcher's own relevance ordering — is the tie-breaker. */
export async function pickFallbackSources(
  text: string,
  turnSources: RankableSource[],
): Promise<MemorySource[]> {
  const pool = dedupeByUrl(turnSources)
  if (pool.length <= MEMORY_MAX_SOURCES) return pool.map(slimSource)

  if (rerankEnabled()) {
    try {
      const docs = pool.map(s => (s.content ? `${s.title} — ${s.content}` : s.title))
      const ranked = (await rerank(text, docs, MEMORY_MAX_SOURCES))
        .map(i => pool[i]).filter((s): s is RankableSource => s != null)
      if (ranked.length) return ranked.slice(0, MEMORY_MAX_SOURCES).map(slimSource)
    } catch (e) {
      console.error('  [memory] source rerank failed, falling back to citation order:', e)
    }
  }
  return [...pool]
    .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER))
    .slice(0, MEMORY_MAX_SOURCES)
    .map(slimSource)
}

/** Inputs for a retroactive extraction over a whole session's stored messages (chat moved into a
 *  space, or "recreate memories"). Several assistant messages get concatenated and each one's `[N]`
 *  markers are positional to its own source list, so the numbers collide — strip them, and hand the
 *  extractor the per-session source pool, which `pickFallbackSources` then ranks and caps per note. */
export function retroExtractionInputs(
  msgs: Array<{ role: 'user' | 'assistant'; content: string; sources: string | null }>,
): { userContent: string; assistantContent: string; sources: RankableSource[] } {
  const userContent = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n\n')
  const assistantContent = msgs.filter(m => m.role === 'assistant')
    .map(m => m.content.replace(/\[\d+\]/g, '')).join('\n\n')
  const sources: RankableSource[] = []
  for (const m of msgs) {
    if (!m.sources) continue
    try { sources.push(...toMemorySources(JSON.parse(m.sources))) } catch { /* skip unparseable */ }
  }
  return { userContent, assistantContent, sources: dedupeByUrl(sources) }
}

/** Strip a line's `[N]` markers (and any `[F1]`/`[C1]` file labels) from the text that gets stored,
 *  and resolve the numeric ones against the turn's ordered source list.
 *
 *  `sources` is set only when the line carried markers: those are the pages that specific note is
 *  about, capped at `MEMORY_MAX_SOURCES`. `sources: []` means it cited markers that resolved to
 *  nothing. `sources: undefined` means no marker at all — the caller ranks the whole turn pool with
 *  `pickFallbackSources`. Pure, so the mapping is unit-tested. */
export function mapFactCitations(rawLine: string, turnSources: MemorySource[] = []): MemoryFact {
  const normalized = splitGroupedCitations(rawLine)
  const nums = new Set<number>()
  for (const m of normalized.matchAll(/\[(\d+)\]/g)) nums.add(Number(m[1]))

  const text = normalized
    .replace(/\[(?:\d+|[FC]\d+)\]/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (!nums.size) return { text }
  const picked = [...nums].sort((a, b) => a - b).map(n => turnSources[n - 1]).filter(Boolean)
  return { text, sources: unionSources(picked) ?? [] }
}
