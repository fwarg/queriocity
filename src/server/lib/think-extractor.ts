/** Tags the extractor recognises. `<think>` is surfaced separately; `<tool_call>` is dropped.
 *
 *  A model whose tools were withheld mid-run may write the call out as prose instead (see
 *  FINAL_STEP_INSTRUCTION in researcher.ts). Nothing else catches it: the request carried no tool
 *  schemas, so the provider's tool-call parser is off and the markup would stream to the user as
 *  the answer. Dropped rather than shown as thinking — it is not reasoning, it is a failed action. */
type Tag = { open: string; close: string; keep: boolean }
const THINK: Tag = { open: '<think>', close: '</think>', keep: true }
const TOOL_CALL: Tag = { open: '<tool_call>', close: '</tool_call>', keep: false }
const TAGS = [THINK, TOOL_CALL]

/** Longest partial opening tag that could still be completed by the next delta. */
const MAX_OPEN = Math.max(...TAGS.map(t => t.open.length))

/** Stateful streaming extractor for <think>...</think> tags. Safe across delta boundaries. */
export class ThinkExtractor {
  private inside: Tag | null = null
  private buf = ''

  process(delta: string): { text: string; thinking: string } {
    let text = ''
    let thinking = ''
    this.buf += delta

    while (this.buf.length > 0) {
      if (this.inside) {
        const { close, keep } = this.inside
        const end = this.buf.indexOf(close)
        if (end === -1) {
          // Hold back a possible partial closing tag, release the rest.
          const safe = Math.max(0, this.buf.length - (close.length - 1))
          if (keep) thinking += this.buf.slice(0, safe)
          this.buf = this.buf.slice(safe)
          break
        }
        if (keep) thinking += this.buf.slice(0, end)
        this.buf = this.buf.slice(end + close.length)
        this.inside = null
      } else {
        const next = TAGS
          .map(tag => ({ tag, at: this.buf.indexOf(tag.open) }))
          .filter(c => c.at !== -1)
          .sort((a, b) => a.at - b.at)[0]
        if (!next) {
          // Hold back a possible partial opening tag, release the rest.
          const safe = Math.max(0, this.buf.length - (MAX_OPEN - 1))
          text += this.buf.slice(0, safe)
          this.buf = this.buf.slice(safe)
          break
        }
        text += this.buf.slice(0, next.at)
        this.buf = this.buf.slice(next.at + next.tag.open.length)
        this.inside = next.tag
      }
    }

    return { text, thinking }
  }

  flush(): { text: string; thinking: string } {
    const remainder = this.buf
    this.buf = ''
    // An unterminated tag takes the rest of the stream with it, kept or dropped as the tag says.
    if (this.inside) return this.inside.keep ? { text: '', thinking: remainder } : { text: '', thinking: '' }
    return { text: remainder, thinking: '' }
  }
}
