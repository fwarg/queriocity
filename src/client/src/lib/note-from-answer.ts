import { splitGroupedCitations } from '@shared/citations.ts'
import type { Message } from './api.ts'

/** Turns an assistant answer into markdown that still makes sense once it leaves the chat.
 *
 *  The sources are held beside the message rather than in it, so they are appended as a list —
 *  the note's own bibliography. The `[17]` markers stay plain, as in the answer: the note renderer
 *  pairs them with that list (shared/note-citations.ts), so each URL is written once and editing
 *  the note does not mean wading through repeated links. The cost is that an excerpt retrieved from
 *  the middle of a long note carries `[3]` without its URL; the note itself is what gets cited. */
export function answerAsNoteBody(msg: Message, sourcesHeading: string): string {
  const sources = msg.sources ?? []
  const body = splitGroupedCitations(msg.content)
  const cited = new Set([...body.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1])))

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

  // Library documents, which have no external URL — named, not linked, under their [F1] label.
  const files = (msg.fileSources ?? []).map(s => `- **[${s.label}]** ${s.title}`)

  if (!listed.length && !files.length) return body.trim()
  return `${body.trim()}\n\n---\n\n## ${sourcesHeading}\n\n${[...listed, ...files].join('\n')}\n`
}
