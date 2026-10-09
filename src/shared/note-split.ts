/** Parts of a split note, and the sources list each carries. Shared because the client merges
 *  parts the same way the server first divides them. */

export interface NotePart {
  title: string
  body: string
  /** Proposed tags, normalised; the user edits them before saving. */
  tags?: string[]
}

/** A note body split from its trailing sources list (`---` then `## Heading` then `- **[n]** …`). */
export function splitSources(body: string): { text: string; heading: string | null; lines: Map<string, string> } {
  const m = /\n---\n+## ([^\n]+)\n+((?:- \*\*\[\w+\]\*\*[^\n]*\n?)+)\s*$/.exec(body)
  if (!m) return { text: body.trim(), heading: null, lines: new Map() }
  const lines = new Map(m[2].trim().split('\n').flatMap(line => {
    const token = /^- \*\*\[(\w+)\]\*\*/.exec(line)?.[1]
    return token ? [[token, line] as const] : []
  }))
  return { text: body.slice(0, m.index).trim(), heading: m[1], lines }
}

/** A part with the source lines its markers cite appended, under the original heading. */
export function withSources(part: NotePart, heading: string | null, lines: Map<string, string>): NotePart {
  if (!heading) return part
  const cited = [...new Set([...part.body.matchAll(/\[(\w+)\]/g)].map(m => m[1]))].flatMap(t => lines.get(t) ?? [])
  return cited.length ? { ...part, body: `${part.body.trim()}\n\n---\n\n## ${heading}\n\n${cited.join('\n')}\n` } : part
}

/** Two parts as one: texts joined, the first title kept, the sources either cites listed once. */
export function mergeParts(a: NotePart, b: NotePart): NotePart {
  const [sa, sb] = [splitSources(a.body), splitSources(b.body)]
  const lines = new Map([...sa.lines, ...sb.lines])
  const tags = [...new Set([...a.tags ?? [], ...b.tags ?? []])]
  return { ...withSources({ title: a.title, body: `${sa.text}\n\n${sb.text}` }, sa.heading ?? sb.heading, lines), ...(tags.length ? { tags } : {}) }
}
