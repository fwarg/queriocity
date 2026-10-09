/** Tag paths, shared by server and client so both normalise identically: hierarchical, lowercase,
 *  `/`-separated (`ml/rag`). */

export const MAX_TAG_CHARS = 100

/** `#Machine Learning / RAG ` → `machine-learning/rag`; '' when nothing usable is left. Spaces become
 *  hyphens rather than being rejected, so an LLM topic like "Svensk historia" adopts cleanly. */
export function normaliseTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^#+/, '')
    .split('/')
    .map(seg => seg.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join('/')
    .slice(0, MAX_TAG_CHARS)
}

/** True when `path` is `tag` itself or nested under it — `ml` covers `ml/rag`, not `mlops`. */
export const isUnder = (path: string, tag: string) => path === tag || path.startsWith(`${tag}/`)

/** `a/b/c` → ['a', 'a/b', 'a/b/c']: every level a path implies. */
export function tagAncestry(path: string): string[] {
  const parts = path.split('/')
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** `#tag` or `#tag/sub` written in note text: after a line start or whitespace (not `page#anchor`),
 *  starting with a letter (not `#1`), and never `# Heading`, which has a space. */
const INLINE_TAG = /(^|\s)#(\p{L}[\p{L}\p{N}_-]*(?:\/[\p{L}\p{N}_-]+)*)/gu
/** Fenced blocks and code spans, kept whole when splitting; a tag inside code is not a tag. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/

/** Maps the prose of a markdown body, leaving code untouched. */
const mapProse = (body: string, fn: (prose: string) => string) =>
  body.split(CODE).map((part, i) => i % 2 ? part : fn(part)).join('')

/** The tags written inline in a note, normalised. */
export function inlineTags(body: string): string[] {
  const found = new Set<string>()
  mapProse(body, prose => {
    for (const m of prose.matchAll(INLINE_TAG)) {
      const tag = normaliseTag(m[2])
      if (tag) found.add(tag)
    }
    return prose
  })
  return [...found]
}

/** Inline tags turned into markdown links, `href` giving each one's target, for rendering. */
export function linkInlineTags(body: string, href: (tag: string) => string): string {
  return mapProse(body, prose => prose.replace(INLINE_TAG, (_, lead: string, raw: string) => `${lead}[#${raw}](${href(normaliseTag(raw))})`))
}
