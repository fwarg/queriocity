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
