import { generateText } from 'ai'
import { getChatModel, CHARS_PER_TOKEN } from '../llm.ts'
import { TRANSFORM_MAX_CHARS } from './transforms.ts'
import { splitSources, withSources, type NotePart } from '../../../shared/note-split.ts'
import { normaliseTag } from '../../../shared/tags.ts'

/** "Split into notes": a long answer or note proposed as several short notes, one idea each — the
 *  Zettelkasten step that is tedious by hand. Only a proposal; the client saves what the user keeps.
 *  Citation markers stay in the text, and each part gets the sources it cites. */

export { splitSources, withSources, type NotePart }

const SYSTEM = `You split a long note into short, self-contained notes for a personal knowledge base, one idea per note.
Rules:
- 2 to 8 notes. Each must make sense read alone: name its subject, do not rely on "as above".
- Keep the wording of the original where possible; do not add facts.
- Keep citation markers such as [3] or [F1] exactly as written, next to the text they support.
- Titles: short and specific, in the note's language.
- Under each title, one line \`tags: a, b/c\` with 1-3 lowercase tags (\`/\` nests them). Reuse the
  user's existing tags where they fit; make a new one only when none does.
- First, one OVERVIEW block: a title for the text as a whole and a 1-3 sentence summary of what it
  covers — judged from the text itself, not from the question or conversation it may have come from.
Respond in exactly this format and nothing else:
=== OVERVIEW: Title for the whole text
tags: topic
summary of the whole text
=== Title of the first note
tags: topic/sub, other
markdown body of the first note
=== Title of the second note
tags: topic/sub
markdown body of the second note`

/** Existing tags offered to the model, most used first; enough to steer it, not to crowd the prompt. */
const MAX_KNOWN_TAGS = 150

/** A proposed split: the parts, and a title and summary for an overview note binding them —
 *  absent when the model left the overview out. */
export interface SplitProposal {
  parts: NotePart[]
  overview?: NotePart
}

const OVERVIEW = /^OVERVIEW:\s*/i

/** The proposed parts of `body`. Throws when the text is too long to split in one pass or the
 *  model's answer is unusable. */
export async function proposeSplit(title: string, body: string, hint = '', knownTags: Array<{ path: string; count: number }> = []): Promise<SplitProposal> {
  const { text, heading, lines } = splitSources(body)
  if (text.length > TRANSFORM_MAX_CHARS) throw new Error(`Too long to split (${text.length} characters, at most ${TRANSFORM_MAX_CHARS})`)
  const { text: reply } = await generateText({
    model: getChatModel(),
    system: SYSTEM,
    // The user's wish for how to split, after a proposal they did not like, ranks above the defaults.
    prompt: `${hint.trim() ? `HOW THE USER WANTS IT SPLIT (follow this over the rules above): ${hint.trim()}\n\n` : ''}${tagContext(knownTags)}TITLE: ${title}\n\n${text}`,
    maxOutputTokens: Math.ceil((text.length * 1.4) / CHARS_PER_TOKEN) + 500,
    abortSignal: AbortSignal.timeout(180_000),
  })
  const blocks = parseParts(reply)
  const overview = blocks.find(b => OVERVIEW.test(b.title))
  const parts = blocks.filter(b => b !== overview)
  if (parts.length < 2) throw new Error('The model did not return a usable split')
  return {
    parts: parts.map(p => withSources(p, heading, lines)),
    ...(overview ? { overview: { ...overview, title: overview.title.replace(OVERVIEW, '').trim() || title } } : {}),
  }
}

/** The model's `=== Title` blocks. Plain text rather than JSON: the bodies are markdown, often with
 *  LaTeX, and a model writing JSON leaves `\d` or `\frac` unescaped — a parse error, or worse, a
 *  silently mangled formula. A stray code fence around the whole answer is dropped. */
export function parseParts(reply: string): NotePart[] {
  const text = reply.trim().replace(/^```\w*\n([\s\S]*?)\n```$/, '$1')
  // A title must follow on the line: a bare `===` is a markdown heading underline, not a block.
  return text.split(/^===[ \t]+(?=[^=\s])/m).slice(1).flatMap(block => {
    const newline = block.indexOf('\n')
    const title = (newline < 0 ? block : block.slice(0, newline)).trim().replace(/^#+\s*/, '')
    const rest = newline < 0 ? '' : block.slice(newline + 1).trim()
    const tagLine = /^tags:[ \t]*(.*)(?:\n|$)/i.exec(rest)
    const body = tagLine ? rest.slice(tagLine[0].length).trim() : rest
    const tags = [...new Set((tagLine?.[1] ?? '').split(',').map(normaliseTag).filter(Boolean))]
    return title && body ? [{ title, body, ...(tags.length ? { tags } : {}) }] : []
  })
}

/** The user's existing tags as prompt context, so proposals reuse them instead of near-duplicates. */
function tagContext(known: Array<{ path: string; count: number }>): string {
  if (!known.length) return ''
  const paths = [...known].sort((a, b) => b.count - a.count).slice(0, MAX_KNOWN_TAGS).map(k => k.path)
  return `EXISTING TAGS: ${paths.join(', ')}\n\n`
}
