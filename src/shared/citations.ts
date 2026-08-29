/** Citation-token helpers shared by the client renderer and the server writer stream.
 *
 *  Both ends have to cope with the same model artefact: a citation group written as `[1, 3]`
 *  in one bracket instead of the `[1][3]` the pipeline expects. The renderer normalizes so a
 *  token the model already emitted still links; the writer stream normalizes so the *stored*
 *  answer — and everything derived from it (note export, chat export, memory extraction,
 *  related-question suggestions) — carries the canonical form. */

/** `[1, 3]`, `[1,3]`, `[1; 3]`, `[1, 2, 3]` — a single bracket holding a separated list of bare
 *  numbers. Rewritten to `[1][3]`. Leaves `[1]`, `[1][2]`, `[F1]`, `[ ]` and `[x]` untouched. */
const GROUPED_CITATION = /\[(\d+(?:\s*[,;]\s*\d+)+)\]/g

export function splitGroupedCitations(text: string): string {
  return text.replace(GROUPED_CITATION, (_m, group: string) =>
    group.split(/\s*[,;]\s*/).map(n => `[${n}]`).join(''))
}
