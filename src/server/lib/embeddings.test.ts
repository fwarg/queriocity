import './test-support/test-env.ts'
import { describe, expect, it } from 'bun:test'
import { _test } from './embeddings.ts'

const { bound, EMBED_MAX_CHARS } = _test

/** The bound exists because embedding servers reject oversized input outright — there is no partial
 *  result: the call 400s and every feature depending on it fails at once. Found when a 170k-char
 *  PDF inlined into a user message reached the *query* embedding, which is never chunked. */
describe('embedding input bound', () => {
  it('passes ordinary text through untouched', () => {
    const text = 'a normal query about the attached contract'
    expect(bound(text)).toBe(text)
  })

  it('caps a whole document pasted as a query', () => {
    expect(bound('x'.repeat(170_000)).length).toBe(EMBED_MAX_CHARS)
  })

  it('leaves the largest chunk this app produces intact', () => {
    // files/ingest.ts chunks documents at 2000 chars; the cap must never clip a stored chunk,
    // which would corrupt its vector silently rather than failing loudly.
    expect(bound('y'.repeat(2000))).toHaveLength(2000)
    expect(EMBED_MAX_CHARS).toBeGreaterThanOrEqual(2000)
  })
})
