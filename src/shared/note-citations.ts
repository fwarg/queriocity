/** Citation markers in a note saved from an answer.
 *
 *  The note's text keeps plain `[1]` / `[F1]` markers, and its sources list at the bottom —
 *  `- **[1]** [Title](url)` — is the one place each URL is written. The renderer pairs the two, so
 *  editing the note never wades through repeated URLs. Shared by the client renderer and the
 *  server's one-off conversion of notes saved in the older form, where every marker carried its
 *  own URL: `[\[1\]](url)`. */

const TOKEN = String.raw`(\d+|[A-Za-z]+\d+)`

/** A bare marker: not part of a wikilink (`[[1]]`), an escaped bracket, the bold label of a source
 *  line (`**[1]**`), or a link or definition (`[1](…)`, `[1]: …`). */
const MARKER = new RegExp(String.raw`(?<![[\\*])\[${TOKEN}\](?![\](:])`, 'g')

/** `- **[1]** [Title](url)` for a web source, `- **[F1]** Title` for a library document. */
const SOURCE_LINE = new RegExp(String.raw`^\s*[-*]\s+\*\*\[${TOKEN}\]\*\*\s+(?:\[([^\]]*)\]\((\S+?)\)|(.+?))\s*$`, 'gm')

/** An old-form marker: `[\[1\]](https://…)`. */
const LINKED_MARKER = new RegExp(String.raw`\[\\\[${TOKEN}\\\]\]\((\S+?)\)`, 'g')

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/

export interface NoteSource { title: string; url: string | null }

/** The note's sources list, by marker token. */
export function noteSources(body: string): Map<string, NoteSource> {
  const sources = new Map<string, NoteSource>()
  for (const m of body.matchAll(SOURCE_LINE)) {
    sources.set(m[1], m[3] ? { title: m[2] || m[3], url: m[3] } : { title: m[4], url: null })
  }
  return sources
}

/** Text outside code, transformed; code spans and blocks pass through untouched. */
const outsideCode = (body: string, fn: (text: string) => string) =>
  body.split(CODE).map((part, i) => i % 2 === 1 ? part : fn(part)).join('')

/** Markers with a matching source become `[\[1\]](href)` links for rendering. A marker with no
 *  source is left as text, as in the chat — usually a number the model invented. */
export function linkNoteCitations(body: string, tokens: Set<string>, href: (token: string) => string): string {
  return outsideCode(body, text => text.replace(MARKER, (m, token: string) =>
    tokens.has(token) ? `[\\[${token}\\]](${href(token)})` : m))
}

/** Markers with a source become keyed footnotes (`[^1]`) and each source line the footnote's
 *  definition, as OKF attributes claims. Markers without a source are left as text. */
export function footnoteCitations(body: string): string {
  const sources = noteSources(body)
  const marked = outsideCode(body, text => text.replace(MARKER, (m, token: string) => sources.has(token) ? `[^${token}]` : m))
  return marked.replace(SOURCE_LINE, (line: string, token: string) => {
    const s = sources.get(token)!
    // The pattern's leading \s* can span blank lines above the item; those are kept.
    const newlines = line.slice(0, line.search(/\S/)).replace(/[^\n]/g, '')
    return `${newlines}[^${token}]: ${s.url ? `[${s.title}](${s.url})` : s.title}`
  })
}

/** The old form back to plain markers — only where the sources list holds that very URL, so a
 *  conversion can never lose one. */
export function plainCitations(body: string): string {
  const sources = noteSources(body)
  return outsideCode(body, text => text.replace(LINKED_MARKER, (m, token: string, url: string) =>
    sources.get(token)?.url === url ? `[${token}]` : m))
}
