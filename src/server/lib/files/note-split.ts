import { generateText } from 'ai'
import { getChatModel, CHARS_PER_TOKEN } from '../llm.ts'
import { TRANSFORM_MAX_CHARS } from './transforms.ts'

/** "Split into notes": a long answer or note proposed as several short notes, one idea each — the
 *  Zettelkasten step that is tedious by hand. Only a proposal; the client saves what the user keeps.
 *  Citation markers stay in the text, and each part gets the sources it cites. */

export interface NotePart {
  title: string
  body: string
}

const SYSTEM = `You split a long note into short, self-contained notes for a personal knowledge base, one idea per note.
Rules:
- 2 to 8 notes. Each must make sense read alone: name its subject, do not rely on "as above".
- Keep the wording of the original where possible; do not add facts.
- Keep citation markers such as [3] or [F1] exactly as written, next to the text they support.
- Titles: short and specific, in the note's language.
Respond with ONLY a JSON array: [{"title":"...","body":"markdown"}].`

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

/** The proposed parts of `body`. Throws when the text is too long to split in one pass or the
 *  model's answer is unusable. */
export async function proposeSplit(title: string, body: string): Promise<NotePart[]> {
  const { text, heading, lines } = splitSources(body)
  if (text.length > TRANSFORM_MAX_CHARS) throw new Error(`Too long to split (${text.length} characters, at most ${TRANSFORM_MAX_CHARS})`)
  const { text: reply } = await generateText({
    model: getChatModel(),
    system: SYSTEM,
    prompt: `TITLE: ${title}\n\n${text}`,
    maxOutputTokens: Math.ceil((text.length * 1.4) / CHARS_PER_TOKEN) + 500,
    abortSignal: AbortSignal.timeout(180_000),
  })
  const json = reply.replace(/```(?:json)?/g, '').trim()
  const parsed = JSON.parse(json.slice(json.indexOf('['), json.lastIndexOf(']') + 1)) as Array<{ title?: unknown; body?: unknown }>
  const parts = parsed.flatMap(p => typeof p.title === 'string' && typeof p.body === 'string' && p.title.trim() && p.body.trim()
    ? [{ title: p.title.trim(), body: p.body.trim() }]
    : [])
  if (parts.length < 2) throw new Error('The model did not return a usable split')
  return parts.map(p => withSources(p, heading, lines))
}
