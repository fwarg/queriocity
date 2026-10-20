import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { saveAgentNote } from '../files/agent-notes.ts'
import { translate } from '../../../shared/i18n/index.ts'
import { languageModel, type ModelTarget } from '../llm.ts'
import { asDocumentReferences } from '../../../shared/citations.ts'
import type { Doc } from './collection-evidence.ts'
import { webBlock, type WebSearching } from './collection-web.ts'
import { userQueryOf, type TurnContext, type TurnSink } from './context.ts'

/** Explore's opt-in note writing: a `save_note` tool that keeps findings as notes in the user's
 *  library, marked as the model's drafts (lib/files/agent-notes.ts). Allowed in a locked turn — the
 *  notes are then confidential, so only locked turns read them. */

/** `docs`: the labels the note cites, for the answer's account of what was covered. */
export interface SavedNote { id: string; title: string; docs: string[] }

/** Atomic notes, Zettelkasten-style: a note about a concept is useful later; a summary of "the study"
 *  is not, without the study at hand. */
const NOTE_STYLE = `Each note explains one concept, method or claim so that it is useful on its own, to a reader who has not seen the documents. Its title names the concept (e.g. "Benjamini–Hochberg FDR correction"), not a document or a section. Its body first explains what the concept is, how it works and when it applies, in general terms — this may come from your own knowledge, and is then left uncited — and then how the documents use, support or dispute it, citing them by label ([C1]) for every claim taken from them. Never write "the study" or "the paper": name the work where it matters. Do not save a note that only summarises a document or a part of one; a finding is worth a note only stated as a claim that holds on its own — what was shown, and under which conditions.`

/** Links between the notes of one run; one to a note not yet saved resolves when it is (links.ts). */
const LINK_INSTRUCTION = `Link each note to the related notes you save in this run by writing [[their exact title]] where the idea comes up, or under "See also".`

/** With web search on: the web may explain a concept, never stand in for what the documents say. */
export const NOTES_WEB_INSTRUCTION = `\nWhen a note's concept needs explaining and you cannot explain it confidently, you may search the web for it, after reading the documents — never for what the documents themselves say. Cite a web result in a note by its number ([3]); it is listed under the note's sources beside the documents. A note must still cite at least one document.`

export const EXPLORE_NOTES_INSTRUCTION = `\nYou can also keep findings in the user's library with save_note, in markdown. ${NOTE_STYLE} ${LINK_INSTRUCTION} Notes are marked as written by you and unreviewed. Saving under the title of a note you saved earlier replaces it; a note the user wrote is never replaced. Save notes only for what is worth keeping beyond this answer. Save each note as soon as you have read what it draws on — do not keep them all for the end: the exploration has a step limit, and notes not saved by then are lost. When the user asks for notes on every document, cover every document: outline each one and read its main parts, rather than only what bears on one question.`

export function saveNoteTool(ctx: TurnContext, sink: TurnSink, model: ModelTarget, docs: Doc[], saved: SavedNote[], web?: WebSearching) {
  const documents = new Map(docs.map(d => [d.label, d.filename]))
  const documentIds = new Map(docs.map(d => [d.label, d.fileId]))
  const lang = ctx.settings.language ?? 'en'
  return tool({
    description: 'Save a note in the user\'s library: a title and a markdown body citing the documents by label, e.g. [C1]. Saving under an earlier title of yours replaces that note.',
    inputSchema: z.object({ title: z.string(), body: z.string() }),
    execute: async ({ title, body }) => {
      const outcome = await saveAgentNote(ctx.userId, {
        title, body, documents, documentIds, web: web?.results, model: model.label ?? model.model,
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

const SAVE_SYSTEM = `You keep findings from a collection of documents as notes in the user's library. Below is what was read and noted while exploring the documents for the user's message. Call save_note once for each concept worth keeping, in markdown. ${NOTE_STYLE} ${LINK_INSTRUCTION} You may call it several times at once. Save only what the material below supports.`
const SAVE_WEB_LINE = ` The web results below may explain a concept; cite one by its number ([3]), and every note still cites at least one document.`
/** For a pass after exploring saved some notes and then ran out of steps. */
const alreadySavedBlock = (saved: SavedNote[]) => saved.length
  ? `## Notes already saved\nExploring ran out of steps after saving these. Save only concepts they do not cover, and never under these titles: that would replace them.\n${saved.map(s => `- ${s.title}`).join('\n')}`
  : ''
/** Steps for the saving pass: enough to save in more than one go. */
const SAVE_STEPS = 4

/** A pass that only saves, for when exploring ended with saving on and nothing saved — the model
 *  answered instead of calling a tool — or at the step limit, with what was read last noted but not
 *  saved. Its findings are saved from what it read and noted, besides the notes already saved. A
 *  failure leaves the answer to report what was saved. */
export async function saveFindings(ctx: TurnContext, sink: TurnSink, model: ModelTarget, docs: Doc[], saved: SavedNote[], material: string, web?: WebSearching) {
  if (!material) return
  const before = saved.length
  const documents = '## The documents\n' + docs.map(d => `- [${d.label}] ${d.filename}`).join('\n')
  try {
    await generateText({
      model: languageModel(model),
      system: [`${SAVE_SYSTEM}${web?.results.length ? SAVE_WEB_LINE : ''}`, documents, alreadySavedBlock(saved), asDocumentReferences(material), webBlock(web)].filter(Boolean).join('\n\n'),
      messages: [{ role: 'user', content: userQueryOf(ctx.msgs) }],
      tools: { save_note: saveNoteTool(ctx, sink, model, docs, saved, web) },
      stopWhen: stepCountIs(SAVE_STEPS),
      abortSignal: ctx.abortSignal,
    })
    console.log(`  [explore] saving pass: ${saved.length - before} saved`)
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
