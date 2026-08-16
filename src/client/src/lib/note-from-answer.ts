import type { Message } from './api.ts'

/** Turns an assistant answer into markdown that still makes sense once it leaves the chat.
 *
 *  Two things break when an answer is copied verbatim into a note. Its `[17]` markers are indices
 *  into a source list the note does not carry, so they read as dead text. And the sources themselves
 *  are held beside the message rather than in it, so they are simply lost.
 *
 *  Markers are rewritten to point straight at the URL rather than to an anchor further down: unlike
 *  the chat export, a note is not a document that contains its own bibliography — it is one resource
 *  among many, and may be read as a retrieved excerpt with everything around it stripped away. */
export function answerAsNoteBody(msg: Message, sourcesHeading: string): string {
  const sources = msg.sources ?? []
  const cited = new Set([...msg.content.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1])))

  const body = sources.length
    ? msg.content.replace(/\[(\d+)\]/g, (match, num) => {
      const source = sources[parseInt(num) - 1]
      return source ? `[\\[${num}\\]](${source.url})` : match
    })
    : msg.content

  // Only the sources the answer actually cites, matching what the message itself lists. A research
  // turn can accumulate dozens of results the writer never used, and a note is not a search log.
  //
  // A bullet list carrying its own `[n]`, not an ordered list: markdown renumbers an ordered list
  // from one, which would silently renumber source 17 to source 3 and break the correspondence with
  // the markers left in the text above.
  const listed = sources
    .map((source, i) => ({ source, n: i + 1 }))
    .filter(({ n }) => cited.has(n))
    .map(({ source, n }) => `- **[${n}]** [${source.title || source.url}](${source.url})`)

  // Library documents, which have no external URL — named, not linked.
  const files = (msg.fileSources ?? []).map(s => `- ${s.title}`)

  if (!listed.length && !files.length) return body.trim()
  return `${body.trim()}\n\n---\n\n## ${sourcesHeading}\n\n${[...listed, ...files].join('\n')}\n`
}
