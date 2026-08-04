/** Budget/ordering rules for memory injection.
 *
 *  `selectMemories` is deliberately pure so the part that decides *what the model sees* can be
 *  tested without an embedder, a reranker or a database. The ranking itself (KNN + optional
 *  rerank) is exercised end-to-end; what is easy to get silently wrong — and what these cover —
 *  is the budget arithmetic and the guarantee that pinned/always-keep entries survive it. */

// Must precede the ./memory.ts import — it reaches lib/db.ts, which opens DB_PATH at load.
import './test-support/test-env.ts'

import { describe, test, expect } from 'bun:test'
import { selectMemories, isSensitiveFact, isDurableUserFact, type MemoryCandidate } from './memory.ts'

/** ~1 token per 4 chars, matching the estimate selectMemories uses. */
const mem = (id: string, tokens: number): MemoryCandidate =>
  ({ id, content: 'x'.repeat(tokens * 4 - 2) }) // -2 for the "- " prefix

describe('selectMemories', () => {
  test('fills the budget from the ranked list in order', () => {
    const ranked = [mem('a', 10), mem('b', 10), mem('c', 10)]
    const { chosen } = selectMemories([], ranked, 25)

    expect(chosen.map(m => m.id)).toEqual(['a', 'b'])
  })

  test('guaranteed memories are injected before ranked ones', () => {
    const { chosen } = selectMemories([mem('pinned', 10)], [mem('a', 10), mem('b', 10)], 25)

    // The pin must win the budget race even though 'a' outranks it on relevance.
    expect(chosen.map(m => m.id)).toEqual(['pinned', 'a'])
  })

  test('reports guaranteed memories that could not fit rather than dropping them silently', () => {
    const { chosen, droppedGuaranteed } = selectMemories([mem('big', 50)], [mem('a', 5)], 20)

    expect(chosen.map(m => m.id)).toEqual(['a'])
    expect(droppedGuaranteed).toBe(1)
  })

  test('skips an oversized entry but keeps filling with smaller ones', () => {
    // A single long memory must not truncate everything after it, which a `break` would do.
    const { chosen } = selectMemories([], [mem('huge', 100), mem('small', 5)], 20)

    expect(chosen.map(m => m.id)).toEqual(['small'])
  })

  test('returns nothing when the budget is exhausted', () => {
    const { chosen } = selectMemories([], [mem('a', 10)], 0)

    expect(chosen).toEqual([])
  })
})

describe('isSensitiveFact', () => {
  // Anything true here would otherwise be offered as a one-click addition to a profile that is
  // injected into every future prompt.
  test.each([
    ['an email address', 'The user can be reached at fredrik.warg@example.com'],
    ['a phone number', 'The user\'s number is +46 70 123 45 67'],
    ['an API key', 'The user\'s token is sk-abcdef0123456789abcdef'],
    ['a long opaque blob', `The key is ${'A1b2C3d4'.repeat(6)}`],
  ])('rejects %s', (_label, fact) => {
    expect(isSensitiveFact(fact)).toBe(true)
  })

  test.each([
    ['a language preference', 'The user works in Swedish and English'],
    ['a tooling constraint', 'The user self-hosts everything and avoids cloud services'],
    ['a formatting preference', 'The user wants concise answers with sources cited inline'],
    ['a date, which is not an identifier', 'The user started the project in March 2026'],
  ])('allows %s', (_label, fact) => {
    expect(isSensitiveFact(fact)).toBe(false)
  })
})

describe('isDurableUserFact', () => {
  // Every rejected case below was actually proposed by a 100-chat scan: two conversations (an
  // hardware thread and a regulation thread) supplied almost the whole list, none of it about the
  // person. The prompt asks for traits; this is the check that does not rely on the model obeying.
  test.each([
    ['a fact about a product', 'The XR-9000 processor has 16 cores'],
    ['a fact about the world', 'The CEO of Acme Corp stepped down in March'],
    ['a topic summary', 'The new AI regulation introduces risk tiers for AI systems'],
    ['something that happened once', 'The user asked about the core count of the XR-9000'],
    ['a conversation recap', 'The user discussed AI regulation in this conversation'],
    ['a reported statement', 'The user mentioned that the deadline is in November'],
  ])('rejects %s', (_label, fact) => {
    expect(isDurableUserFact(fact)).toBe(false)
  })

  test.each([
    ['a language preference', 'The user writes in Swedish and English'],
    ['an infrastructure constraint', 'The user self-hosts everything and avoids cloud services'],
    ['a role', 'The user is a software engineer working on developer tooling'],
    ['a formatting preference', 'The user wants concise answers with inline citations'],
    ['a bare "User" prefix', 'User prefers dark mode across all applications'],
  ])('accepts %s', (_label, fact) => {
    expect(isDurableUserFact(fact)).toBe(true)
  })
})
