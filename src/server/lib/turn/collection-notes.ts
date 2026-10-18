import { tool } from 'ai'
import { z } from 'zod'
import { saveAgentNote } from '../files/agent-notes.ts'
import { translate, type Lang } from '../../../shared/i18n/index.ts'
import type { ModelTarget } from '../llm.ts'
import type { Doc } from './collection-evidence.ts'
import type { TurnContext, TurnSink } from './context.ts'

/** Explore's opt-in note writing: a `save_note` tool that keeps findings as notes in the user's
 *  library, marked as the model's drafts (lib/files/agent-notes.ts). Allowed in a locked turn — the
 *  notes are then confidential, so only locked turns read them. */

export interface SavedNote { id: string; title: string }

export const EXPLORE_NOTES_INSTRUCTION = `\nYou can also keep findings in the user's library with save_note: one note per idea or concept, self-contained, in markdown, citing the documents by label ([C1]) for every claim. Notes are marked as written by you and unreviewed. Saving under the title of a note you saved earlier replaces it; a note the user wrote is never replaced. Save notes only for what is worth keeping beyond this answer, and save them after reading the parts they draw on.`

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
      if (!saved.some(s => s.id === outcome.id)) saved.push({ id: outcome.id, title: outcome.title })
      await sink.step({ kind: 'savedNote', count: saved.length, update: saved.length > 1 })
      if (outcome.kind === 'alongside') return `The user has a note titled "${outcome.existing}"; saved yours as "${outcome.title}", linking to it.`
      return outcome.kind === 'updated' ? `Replaced your earlier note "${outcome.title}".` : `Saved "${outcome.title}".`
    },
  })
}

/** What the answer is told about the notes saved, so it can mention them. */
export function savedNotesBlock(saved: SavedNote[]): string {
  if (!saved.length) return ''
  return `## Notes saved to the user's library while exploring\n${saved.map(s => `- ${s.title}`).join('\n')}\nMention briefly that these notes were saved, as unreviewed drafts the user can check.`
}
