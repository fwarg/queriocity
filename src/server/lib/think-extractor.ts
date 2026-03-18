/** Stateful streaming extractor for <think>...</think> tags. Safe across delta boundaries. */
export class ThinkExtractor {
  private inThink = false
  private buf = ''

  process(delta: string): { text: string; thinking: string } {
    let text = ''
    let thinking = ''
    this.buf += delta

    while (this.buf.length > 0) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>')
        if (end === -1) {
          // Keep last 7 chars buffered (partial tag), flush rest as thinking
          const safe = Math.max(0, this.buf.length - 7)
          thinking += this.buf.slice(0, safe)
          this.buf = this.buf.slice(safe)
          break
        }
        thinking += this.buf.slice(0, end)
        this.buf = this.buf.slice(end + 8)
        this.inThink = false
      } else {
        const start = this.buf.indexOf('<think>')
        if (start === -1) {
          // Keep last 6 chars buffered (partial tag), flush rest as text
          const safe = Math.max(0, this.buf.length - 6)
          text += this.buf.slice(0, safe)
          this.buf = this.buf.slice(safe)
          break
        }
        text += this.buf.slice(0, start)
        this.buf = this.buf.slice(start + 7)
        this.inThink = true
      }
    }

    return { text, thinking }
  }

  flush(): { text: string; thinking: string } {
    const remainder = this.buf
    this.buf = ''
    if (this.inThink) return { text: '', thinking: remainder }
    return { text: remainder, thinking: '' }
  }
}
