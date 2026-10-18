import { sqlite } from './db.ts'
import { documentParts, joinChunks } from './files/collection-parts.ts'
import type { ActiveRecipe } from '../../shared/recipes.ts'

/** A recipe as prompt text (shared/recipes.ts). Instruction notes act as instructions only here,
 *  through a recipe the user picked — a note retrieval returns stays data. Examples give the form
 *  of the answer, never its facts. */

export interface RecipePrompt {
  /** For every pass that reasons about the request. */
  instructions: string
  /** For the pass that writes the answer; empty without examples. */
  examples: string
}

/** Shares of the answering model's room: a style guide is short, an example may be a whole report. */
const INSTRUCTIONS_SHARE = 0.15
const EXAMPLES_SHARE = 0.3

interface Row { id: string; title: string; kind: string; body: string | null }

/** The recipe's text, with only the user's own resources and instructions only from notes, each cut
 *  to its share of `charBudget`. A long example keeps its opening: that is where its form shows. */
export function recipePrompt(userId: string, recipe: ActiveRecipe, charBudget: number): RecipePrompt {
  const notes = owned(userId, recipe.instructionNoteIds).filter(r => r.kind === 'note' && r.body?.trim())
  const examples = owned(userId, recipe.exampleFileIds)
    .map(r => ({ title: r.title, text: r.kind === 'note' ? r.body ?? '' : joinChunks(documentParts(r.id).map(p => p.text)) }))
    .filter(e => e.text.trim())
  const noteRoom = Math.floor(charBudget * INSTRUCTIONS_SHARE / Math.max(1, notes.length))
  const exampleRoom = Math.floor(charBudget * EXAMPLES_SHARE / Math.max(1, examples.length))
  return {
    instructions: notes.length ? [
      `## Recipe "${recipe.name}": instructions the user chose for this chat`,
      'Follow them. Where they conflict with the user\'s standing preferences or the space\'s memory, these win.',
      ...notes.map(n => `### ${n.title}\n${cut(n.body!.trim(), noteRoom)}`),
    ].join('\n\n') : '',
    examples: examples.length ? [
      '## Examples to imitate',
      'Write in the form of these examples: their structure, headings, tone, length and citation habits. Take no facts from them; the facts come from this chat\'s sources.',
      ...examples.map(e => `### ${e.title}\n${cut(e.text.trim(), exampleRoom)}`),
    ].join('\n\n') : '',
  }
}

/** The given resources the user owns, in the given order. */
function owned(userId: string, ids: string[]): Row[] {
  if (!ids.length) return []
  const rows = sqlite.query(`SELECT id, filename AS title, kind, body FROM uploaded_files
    WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(userId, ...ids) as Row[]
  return ids.flatMap(id => rows.filter(r => r.id === id))
}

/** `text` within `room` characters, ending at a paragraph break when one is near. */
function cut(text: string, room: number): string {
  if (text.length <= room) return text
  const head = text.slice(0, room)
  const paragraph = head.lastIndexOf('\n\n')
  return `${paragraph > room * 0.7 ? head.slice(0, paragraph) : head}\n\n[… cut to fit; the rest is left out]`
}
