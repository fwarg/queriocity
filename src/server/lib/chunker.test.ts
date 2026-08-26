import { describe, expect, it } from 'bun:test'
import { semanticChunk } from './chunker.ts'

/** Chunking is where a surrogate pair gets cut in half. A JS string index counts UTF-16 code units,
 *  so an emoji is two of them, and an oversized paragraph is split by index. The orphan then travels
 *  all the way to the embedding server, which rejects the whole batch — so an emoji at an unlucky
 *  offset in one document fails the entire ingest. embeddings.ts strips them as a last resort; this
 *  is about not producing them, which keeps the character itself. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('semanticChunk', () => {
  it('never cuts a surrogate pair in half', () => {
    // The pair has to straddle the cut: high surrogate at index 1999, low at 2000.
    const paragraph = 'x'.repeat(1999) + '🔒' + 'y'.repeat(500)
    const chunks = semanticChunk(paragraph, 2000, 300, 50)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.filter(c => LONE_SURROGATE.test(c))).toEqual([])
  })

  it('keeps the character whole in the overlapping chunk, so nothing is lost', () => {
    const paragraph = 'x'.repeat(1999) + '🔒' + 'y'.repeat(500)
    expect(semanticChunk(paragraph, 2000, 300, 50).some(c => c.includes('🔒'))).toBe(true)
  })

  it('survives a paragraph that is nothing but emoji', () => {
    const chunks = semanticChunk('🔒'.repeat(3000), 2000, 300, 50)
    expect(chunks.filter(c => LONE_SURROGATE.test(c))).toEqual([])
  })

  it('still splits ordinary prose at sentence boundaries', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} carries a little text.`).join(' ')
    const chunks = semanticChunk(text, 200, 40, 50)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200)
  })

  it('drops nothing from text with no surrogates at all', () => {
    expect(semanticChunk('One short paragraph.', 2000, 300, 0)).toEqual(['One short paragraph.'])
  })
})
