/** Recipes: a custom template that also carries instruction notes (a style guide, a procedure),
 *  examples to imitate, and chat settings. Picking one puts a chip in the chat input; while it is
 *  there, every message of the chat carries it, so follow-ups keep the style. */

import type { CollectionMode } from './context.ts'

export const MAX_INSTRUCTION_NOTES = 3
export const MAX_EXAMPLES = 2
/** Instructions typed into the recipe itself: short rules, not a guide (that is a note). */
export const MAX_INSTRUCTION_TEXT = 4000

/** Chat-input settings a recipe applies when picked; each is left as it is when absent. */
export interface RecipeSettings {
  collectionIds?: string[]
  collectionMode?: CollectionMode
  exploreWeb?: boolean
}

/** What a chat request carries while a recipe's chip is in the input. */
export interface ActiveRecipe {
  name: string
  /** Typed in the recipe, so the user's own words: unlike a note, nothing to review. */
  instructionText?: string
  instructionNoteIds: string[]
  exampleFileIds: string[]
}

export const isRecipe = (r: { instructionText?: string; instructionNoteIds: string[]; exampleFileIds: string[] }) =>
  !!r.instructionText?.trim() || r.instructionNoteIds.length > 0 || r.exampleFileIds.length > 0
