/** `[[Title]]` / `[[Title|label]]` in a note body, made renderable as ordinary markdown links.
 *
 *  Each becomes `[label](#wikilink=Title)`: a fragment URL, which react-markdown's URL sanitiser
 *  keeps, and which no real page can produce, so the renderer can tell a wikilink from any other
 *  link. Code spans and fences are left alone, matching the server's parser (lib/files/links.ts). */

export const WIKILINK_PREFIX = '#wikilink='

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/
const WIKILINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g

const encode = (title: string) => encodeURIComponent(title).replace(/\(/g, '%28').replace(/\)/g, '%29')

/** Markdown with wikilinks rewritten as fragment links. */
export function wikilinksToMarkdown(body: string): string {
  return body.split(CODE).map((part, i) =>
    i % 2 === 1 ? part : part.replace(WIKILINK, (_m, title: string, label?: string) => {
      const text = (label?.trim() || title.trim()).replace(/[[\]]/g, '')
      return `[${text}](${WIKILINK_PREFIX}${encode(title.trim())})`
    }),
  ).join('')
}

/** The title a rendered wikilink points at, or null for any other href. */
export function wikilinkTitle(href: string | undefined): string | null {
  if (!href?.startsWith(WIKILINK_PREFIX)) return null
  try { return decodeURIComponent(href.slice(WIKILINK_PREFIX.length)) } catch { return null }
}

export { wikilinkFor } from '@shared/wikilinks.ts'
