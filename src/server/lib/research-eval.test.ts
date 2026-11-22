/** The eval's scoring, without a model: what counts as containing the answer, a valid citation, a search. */

import { describe, test, expect } from 'bun:test'
import { parseEvalItems, containsAnswer, citationStats, traceStats, summarize, type ItemScore } from './research-eval.ts'
import type { ResearchTrace } from './feedback.ts'

describe('parseEvalItems', () => {
  test('skips blanks and comments, and refuses an item without an answer', () => {
    expect(parseEvalItems('// note\n\n{"id":"a","question":"q","answer":"x"}\n')).toHaveLength(1)
    expect(() => parseEvalItems('{"id":"a","question":"q"}')).toThrow('line 1')
  })
})

describe('containsAnswer', () => {
  const item = { id: 'i', question: 'q', answer: 'Öresund Bridge', aliases: ['8259'] }
  test('matches whole words, ignoring case, accents and punctuation', () => {
    expect(containsAnswer('It was the oresund bridge.', item)).toBe(true)
    expect(containsAnswer('See RFC 8259 [1].', item)).toBe(true)
    expect(containsAnswer('RFC 82590', item)).toBe(false)
  })
})

describe('citationStats', () => {
  test('counts grouped markers separately and checks each against the sources', () => {
    expect(citationStats('A [1][2] and B [3, 4].', 3)).toEqual({ citations: 4, validCitations: 3 })
  })
})

describe('traceStats', () => {
  test('counts queries and pages, ignoring in-place updates', () => {
    const trace = { entries: [
      { t: 0, step: { kind: 'search', queries: ['a', 'b'] } },
      { t: 1, step: { kind: 'read', hosts: ['x.se'] } },
      { t: 2, step: { kind: 'read', hosts: ['x.se'], update: true } },
      { t: 3, type: 'sources', sources: [] },
    ] } as unknown as ResearchTrace
    expect(traceStats(trace)).toEqual({ searchQueries: 2, pagesRead: 1 })
  })
})

describe('summarize', () => {
  test('judge accuracy counts only judged items; citation validity pools citations', () => {
    const base = { category: 'c', run: 1, sources: 1, searchQueries: 2, pagesRead: 0, elapsedMs: 10 }
    const scores: ItemScore[] = [
      { ...base, id: 'a', contains: true, judge: true, citations: 3, validCitations: 3 },
      { ...base, id: 'b', contains: false, judge: null, citations: 1, validCitations: 0 },
    ]
    const s = summarize(scores)
    expect(s.judgeAccuracy).toBe(1)
    expect(s.containsAccuracy).toBe(0.5)
    expect(s.citationValidity).toBe(0.75)
  })
})
