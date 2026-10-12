import type { TextStreamPart, ToolSet } from 'ai'
import { ThinkExtractor } from '../think-extractor.ts'
import { CitationNormalizer } from '../citation-normalizer.ts'
import type { TurnSink } from './context.ts'

/** Streams answer text to the client — think markup split off, citations normalised — and keeps the total. */
export class AnswerStream {
  content = ''
  private readonly extractor = new ThinkExtractor()
  private readonly citations: CitationNormalizer | null
  private readonly showThinking: boolean

  constructor(private readonly sink: TurnSink, { showThinking = false, citations = true } = {}) {
    this.showThinking = showThinking
    this.citations = citations ? new CitationNormalizer() : null
  }

  /** Raw model text, which may still carry <think> or <tool_call> markup. */
  async raw(delta: string) {
    const { text, thinking } = this.extractor.process(delta)
    await this.thinking(thinking)
    await this.text(text)
  }

  /** Text already free of markup. */
  async text(delta: string) {
    const clean = this.citations && delta ? this.citations.process(delta) : delta
    if (!clean) return
    this.content += clean
    await this.sink.emit({ type: 'text', delta: clean })
  }

  async thinking(delta: string) {
    if (delta && this.showThinking) await this.sink.emit({ type: 'thinking', delta })
  }

  /** Flushes what the extractor and normaliser still hold back. */
  async end() {
    const { text, thinking } = this.extractor.flush()
    await this.thinking(thinking)
    await this.text(text)
    const tail = this.citations?.flush()
    if (!tail) return
    this.content += tail
    await this.sink.emit({ type: 'text', delta: tail })
  }

  /** Drains a model stream into the answer; `reasoning` also forwards a separate reasoning channel. */
  async consume<TOOLS extends ToolSet>(stream: AsyncIterable<TextStreamPart<TOOLS>>, { reasoning = false } = {}) {
    for await (const part of stream) {
      if (part.type === 'text-delta') await this.raw(part.text)
      else if (part.type === 'reasoning-delta' && reasoning) await this.thinking(part.text)
      else if (part.type === 'error') console.error('  [answer] stream error:', part.error)
    }
    await this.end()
    return this.content
  }
}
