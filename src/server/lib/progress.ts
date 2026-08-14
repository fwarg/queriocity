/** Structured progress steps for the client's activity log.
 *
 *  Two shapes share the `status` event. A bare `{ text }` is the transient one-line message it
 *  has always been (errors, flash's "Thinking…"); adding `step` marks it as an entry in the log
 *  the client builds and collapses once the answer starts. `text` is still filled in either way,
 *  so consumers that only read it — PromptStudio — are unaffected.
 *
 *  Durations are deliberately not sent: the client times the gap between steps itself, which
 *  keeps the wall-clock honest across a slow connection and needs no extra events. */

export type StepKind =
  | 'understand'   // reformulating, building context — before anything is fetched
  | 'read'         // fetching URLs the user pasted
  | 'search'       // web searches, with the queries that were run
  | 'results'      // what a search returned
  | 'reason'       // an LLM step between tool calls
  | 'write'        // final answer pass (thorough writer, synthesis fallback)
  | 'memory'       // save_to_memory tool
  | 'image'        // diffusion generate/edit

export interface ProgressStep {
  kind: StepKind
  /** Every query in the batch. The client shows the first and folds the rest behind "+N more". */
  queries?: string[]
  /** Hostnames, not full URLs — the log has one line to spend. */
  hosts?: string[]
  count?: number
  index?: number
  total?: number
  /** Free-text rider on the line: which image operation, or what a fetched page had to be
   *  reduced to (see describeOutcome in fetch-url.ts). */
  detail?: string
}

/** The one-line prose form, kept identical to what the status line showed before the log existed. */
export function stepText(step: ProgressStep): string {
  switch (step.kind) {
    case 'understand': return 'Understanding your question…'
    case 'read':       return `Reading: ${step.hosts?.join(', ') ?? ''}${step.detail ? ` — ${step.detail}` : ''}`
    case 'search':     return `Searching: ${(step.queries ?? []).map(q => `"${q}"`).join(', ')}`
    case 'results':    return `Found ${step.count ?? 0} result${step.count === 1 ? '' : 's'}`
    case 'reason':     return step.total ? `Thinking (step ${step.index} of ${step.total})…` : 'Thinking…'
    case 'write':      return step.detail ?? 'Writing answer…'
    case 'memory':     return 'Saving to memory…'
    case 'image':      return step.detail ?? 'Generating image…'
  }
}

/** SSE payload for one step. */
export function stepEvent(step: ProgressStep): string {
  return JSON.stringify({ type: 'status', text: stepText(step), step })
}
