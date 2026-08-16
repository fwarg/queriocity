/** The prompts that turn a stored resource into something new — Open Notebook calls these
 *  transformations. Shared by the space-wide summariser (routes/memories.ts) and the per-resource
 *  transform (routes/files.ts), which differ only in what they collect and where they save.
 *
 *  A user's own prompt templates can be run the same way; see `transformPrompt`. */

export const TRANSFORM_OPERATIONS = ['summarize', 'keypoints', 'questions', 'outline'] as const
export type TransformOperation = typeof TRANSFORM_OPERATIONS[number]

/** How much resource text a transform reads. Roughly 6k tokens, well inside every chat model here. */
export const TRANSFORM_MAX_CHARS = 24000

/** Answers follow the document rather than the UI, matching how the research prompts treat the
 *  user's own language — a summary of a Swedish report is of no use in English. */
const LANGUAGE_RULE = 'Write in the same language as the source material.'

/** The output is saved as a note and read on its own, often as a retrieved excerpt with nothing
 *  around it. Without this, `questions` in particular produced a bare list — the questions were
 *  sound, but nothing on the page said what they were about. */
const STANDALONE_RULE = 'Begin with one sentence naming what the source material is about, then give your answer. The result is stored as a standalone note and will be read without the source beside it.'

const INSTRUCTIONS: Record<TransformOperation, string> = {
  summarize: 'Summarize the key information from the following resource excerpts into a concise set of bullet points. Focus on the most important facts, findings, and conclusions. Be comprehensive but avoid redundancy.',
  keypoints: 'Extract the key claims, facts and figures from the following resource excerpts. Give one bullet per point, each self-contained enough to be read on its own, and keep the numbers exact.',
  questions: 'Read the following resource excerpts and list the questions they leave open: gaps in the evidence, claims that are asserted without support, and what a reader would need to check next. One bullet each; do not summarize the content beyond the opening sentence.',
  outline: 'Produce a hierarchical outline of the following resource excerpts, using markdown headings and nested bullets, that mirrors how the material is actually structured. No commentary beyond the opening sentence.',
}

/** The full prompt for a built-in operation, or for a user's own template text. */
export function transformPrompt(instruction: string, context: string): string {
  return `${instruction}\n\n${STANDALONE_RULE}\n${LANGUAGE_RULE}\n\n${context}`
}

export const operationPrompt = (operation: TransformOperation, context: string): string =>
  transformPrompt(INSTRUCTIONS[operation], context)
