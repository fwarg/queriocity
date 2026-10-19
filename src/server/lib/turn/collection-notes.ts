import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { saveAgentNote } from '../files/agent-notes.ts'
import { translate, type Lang } from '../../../shared/i18n/index.ts'
import { languageModel, type ModelTarget } from '../llm.ts'
import { asDocumentReferences } from '../../../shared/citations.ts'
import type { Doc } from './collection-evidence.ts'
import { userQueryOf, type TurnContext, type TurnSink } from './context.ts'

/** Explore's opt-in note writing: a `save_note` tool that keeps findings as notes in the user's
 *  library, marked as the model's drafts (lib/files/agent-notes.ts). Allowed in a locked turn — the
 *  notes are then confidential, so only locked turns read them. */

/** `docs`: the labels the note cites, for the answer's account of what was covered. */
export interface SavedNote { id: string; title: string; docs: string[] }

/** Links between the notes of one run; one to a note not yet saved resolves when it is (links.ts). */
const LINK_INSTRUCTION = `Link each note to the related notes you save in this run by writing [[their exact title]] where the idea comes up, or under "See also".`

export const EXPLORE_NOTES_INSTRUCTION = `\nYou can also keep findings in the user's library with save_note: one note per idea or concept, self-contained, in markdown, citing the documents by label ([C1]) for every claim. ${LINK_INSTRUCTION} Notes are marked as written by you and unreviewed. Saving under the title of a note you saved earlier replaces it; a note the user wrote is never replaced. Save notes only for what is worth keeping beyond this answer. Save each note as soon as you have read what it draws on — do not keep them all for the end: the exploration has a step limit, and notes not saved by then are lost. When the user asks for notes on every document, cover every document: outline each one and read its main parts, rather than only what bears on one question.`

export function saveNoteTool(ctx: TurnContext, sink: TurnSink, model: ModelTarget, docs: Doc[], saved: SavedNote[]) {
  const documents = new Map(docs.map(d => [d.label, d.filename]))
  const lang = (ctx.settings.language as Lang | undefined) ?? 'en'
  return tool({
    description: 'Save a note in the user\'s library: a title and a markdown body citing the documents by label, e.g. [C1]. Saving under an earlier title of yours replaces that note.',
    inputSchema: z.object({ title: z.string(), body: z.string() }),
    execute: async ({ title, body }) => {
      const outcome = await saveAgentNote(ctx.userId, {
        title, body, documents, model: model.label ?? model.model,
        sourcesHeading: translate(lang, 'note.sources'), confidential: ctx.locked,
      })
      if (outcome.kind === 'refused') return `Not saved: ${outcome.reason}`
      const cited = { id: outcome.id, title: outcome.title, docs: [...documents.keys()].filter(l => body.includes(`[${l}]`)) }
      const i = saved.findIndex(s => s.id === outcome.id)
      if (i < 0) saved.push(cited)
      else saved[i] = cited
      await sink.step({ kind: 'savedNote', count: saved.length, update: saved.length > 1 })
      if (outcome.kind === 'alongside') return `The user has a note titled "${outcome.existing}"; saved yours as "${outcome.title}", linking to it.`
      return outcome.kind === 'updated' ? `Replaced your earlier note "${outcome.title}".` : `Saved "${outcome.title}".`
    },
  })
}

const SAVE_SYSTEM = `You keep findings from a collection of documents as notes in the user's library. Below is what was read and noted while exploring the documents for the user's message. Call save_note once for each idea or concept worth keeping — self-contained, in markdown, citing the documents by label ([C1]) for every claim. ${LINK_INSTRUCTION} You may call it several times at once. Save only what the material below supports.`
/** Steps for the saving pass: enough to save in more than one go. */
const SAVE_STEPS = 4

/** A pass that only saves, for when exploring ended with saving on and nothing saved: the model ran
 *  out of steps, or answered instead of calling a tool. Its findings are saved from what it read and
 *  noted. A failure leaves the answer to say that nothing was saved. */
export async function saveFindings(ctx: TurnContext, sink: TurnSink, model: ModelTarget, docs: Doc[], saved: SavedNote[], material: string) {
  if (!material) return
  const documents = '## The documents\n' + docs.map(d => `- [${d.label}] ${d.filename}`).join('\n')
  try {
    await generateText({
      model: languageModel(model),
      system: `${SAVE_SYSTEM}\n\n${documents}\n\n${asDocumentReferences(material)}`,
      messages: [{ role: 'user', content: userQueryOf(ctx.msgs) }],
      tools: { save_note: saveNoteTool(ctx, sink, model, docs, saved) },
      stopWhen: stepCountIs(SAVE_STEPS),
      abortSignal: ctx.abortSignal,
    })
    console.log(`  [explore] saving pass: ${saved.length} saved`)
  } catch (e) {
    if (ctx.abortSignal.aborted) throw e
    console.error('  [explore] saving pass failed:', e)
  }
}

/** What the answer is told about the notes saved, so it can mention them — and, when saving was on
 *  but none were, so it cannot claim otherwise. `saved` is undefined when saving was off. The notes
 *  themselves are not repeated: rewritten in the answer they ran past its length cap, and differed
 *  from what was saved. */
export function savedNotesBlock(saved: SavedNote[] | undefined, docs: Doc[]): string {
  if (!saved) return ''
  if (!saved.length) return `## No notes were saved\nSaving notes to the user's library was on, but none were saved while exploring. Say so plainly at the start of the answer, and never claim that a note was saved.`
  const list = saved.map(s => `- ${s.title}${s.docs.length ? ` (cites ${s.docs.join(', ')})` : ''}`).join('\n')
  const uncovered = docs.filter(d => !saved.some(s => s.docs.includes(d.label))).map(d => d.label)
  return `## Notes saved to the user's library while exploring\n${list}\n${uncovered.length ? `No saved note cites ${uncovered.join(', ')}.\n` : ''}These are unreviewed drafts the user can check. When the user's message asks for notes, do not write the notes out again: give a short report — one line per note on what it covers, briefly where the documents agree or differ, and which documents no note covers. Never present as saved anything not in this list. Otherwise answer the message as usual and mention the notes briefly.`
}
