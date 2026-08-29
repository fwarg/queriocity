import { splitGroupedCitations } from '../../shared/citations.ts'

/** Stateful, streaming clean-up for a writer/researcher answer, applied between the model text
 *  and both the SSE stream and the stored `fullContent`. Two jobs:
 *
 *  1. Rewrite grouped citations — `[1, 3]` → `[1][3]` — so the stored answer carries the canonical
 *     form the rest of the pipeline (note/chat export, memory extraction) recognises. The client
 *     renderer does the same at display time; this keeps what is persisted in step with it.
 *
 *  2. Drop a trailing reference list. The mode prompts forbid one, but a model that adds it anyway
 *     ("## Sources", then bare `[2]` lines with titles) would otherwise stream it to the user and
 *     store it — where the `[2]` lines read as dead text and duplicate the real source panel.
 *
 *  Line-buffered: complete lines are emitted as they close (the writer prompt mandates short
 *  paragraphs and lists, so this streams much like token output), and a suffix that could still
 *  become a grouped citation, or an opening line of a reference list, is held until it resolves.
 *  A held block is only actually dropped when it is clearly a reference list — a "Sources"/
 *  "References" heading, or two or more bare `[N]` lines. Anything less confident is released.
 */

/** Heading or label that opens a reference list. Deliberately narrow — real answer sections are
 *  not called these. "Further reading" is excluded: it can be legitimate linked content. */
const TRAILER_HEADING = /^(?:#{1,6}\s*|\*\*\s*)?(?:sources?|references?|bibliography|citations?|källor|referenser)\s*:?\s*\*{0,2}\s*$/i
/** A citation alone on its own line — the shape a bare-number reference list takes. */
const BARE_CITATION_LINE = /^[-*]?\s*\[\d+\]\s*$/
/** A line that continues a reference list once one has started. */
const TRAILER_CONTINUATION = /^(?:[-*]\s*)?\[\d+\][:.)\s]|^\d+\.\s|^[-*]\s|^\[[^\]]+\]\([^)]*\)\s*$|^https?:\/\/\S+$/i
/** Never hold a still-open last line longer than this waiting for it to resolve. */
const MAX_PARTIAL_HOLD = 200

/** True while the still-open last line could still become a grouped citation or a reference-list
 *  opener — i.e. it is only leading markers plus at most one unfinished word, or an unclosed
 *  `[1, 2` citation. Anything with real prose in it fails this and is released. */
function mightStillBecomeSpecial(partial: string): boolean {
  if (partial.length > MAX_PARTIAL_HOLD) return false
  if (/\[[\d\s,;]*$/.test(partial)) return true                     // unclosed grouped citation
  if (/^\s*[-*]?\s*\[\d[\d\s,;]*\]?\s*$/.test(partial)) return true  // partial bare `[N]` line
  return /^\s*[#*]*\s*[\p{L}]*\s*$/u.test(partial)                   // markers + one word in progress
}

export class CitationNormalizer {
  private buf = ''
  /** Lines withheld as a possible trailing reference list, kept verbatim (newline included). */
  private held: string[] = []
  /** The last held line was a bare `[N]`, so the next non-blank line is its title. */
  private expectTitle = false
  private sawHeading = false
  private bareCount = 0

  process(delta: string): string {
    this.buf += delta
    let out = ''
    while (this.buf.includes('\n')) {
      const nl = this.buf.indexOf('\n')
      out += this.consumeLine(this.buf.slice(0, nl + 1))
      this.buf = this.buf.slice(nl + 1)
    }
    if (this.held.length === 0 && !mightStillBecomeSpecial(this.buf)) {
      out += splitGroupedCitations(this.buf)
      this.buf = ''
    }
    return out
  }

  flush(): string {
    let out = ''
    if (this.buf) {
      out += this.consumeLine(this.buf)
      this.buf = ''
    }
    // A held block at the end is dropped only when it is confidently a reference list; otherwise
    // it was probably ordinary content that just happened to start like one — release it.
    if (this.held.length > 0 && !this.trailerConfident()) out += this.held.join('')
    this.resetHold()
    return out
  }

  private resetHold(): void {
    this.held = []
    this.expectTitle = false
    this.sawHeading = false
    this.bareCount = 0
  }

  private trailerConfident(): boolean {
    return this.sawHeading || this.bareCount >= 2
  }

  private hold(norm: string, trimmed: string): void {
    this.held.push(norm)
    this.expectTitle = BARE_CITATION_LINE.test(trimmed)
    if (TRAILER_HEADING.test(trimmed)) this.sawHeading = true
    if (BARE_CITATION_LINE.test(trimmed)) this.bareCount++
  }

  private consumeLine(line: string): string {
    const norm = splitGroupedCitations(line)
    const trimmed = norm.trim()

    if (this.held.length === 0) {
      if (this.opensTrailer(trimmed)) {
        this.hold(norm, trimmed)
        return ''
      }
      return norm
    }

    // Already holding a suspected trailer.
    if (trimmed === '') {
      this.held.push(norm)
      return ''
    }
    if (this.continuesTrailer(trimmed)) {
      this.hold(norm, trimmed)
      return ''
    }
    // Real content resumed: the held lines were not a trailer. Release them and re-judge this line.
    const flushed = this.held.join('')
    this.resetHold()
    if (this.opensTrailer(trimmed)) {
      this.hold(norm, trimmed)
      return flushed
    }
    return flushed + norm
  }

  private opensTrailer(trimmed: string): boolean {
    return TRAILER_HEADING.test(trimmed) || BARE_CITATION_LINE.test(trimmed)
  }

  private continuesTrailer(trimmed: string): boolean {
    if (this.expectTitle) return true             // the title line after a bare [N]
    return BARE_CITATION_LINE.test(trimmed) || TRAILER_CONTINUATION.test(trimmed) || TRAILER_HEADING.test(trimmed)
  }
}
