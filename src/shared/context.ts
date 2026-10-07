/** What the model saw of the conversation on one turn, sent to the client after history trimming.
 *
 *  Indices refer to the messages array of that request, which is the client's transcript up to and
 *  including the question. Unpinned messages before `cut` were not seen in full; those before
 *  `lostBefore` were not seen at all. Without compression the two are equal; with it, the range
 *  between them was folded into `summary`. Token counts are estimates (chars / 4). */
export interface ContextReport {
  /** Everything the model may read this turn; what is left after the parts below is the room
   *  for search results and fetched pages. */
  budgetTokens: number
  systemTokens: number
  pinnedTokens: number
  historyTokens: number
  summaryTokens: number
  cut: number
  lostBefore: number
  /** A pinned message had to be shortened because the pins alone did not fit. */
  pinnedTruncated: boolean
  summary?: string
}

/** A user message carrying an attached document, as ChatInput inlines it: `\n\n---\n[name]\n…`.
 *  Such a message is pinned by default — the conversation is usually about the document. */
export const hasAttachment = (content: string) => /\n\n---\n\[/.test(content)
