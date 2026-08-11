import './test-support/test-env.ts'
import { describe, expect, it } from 'bun:test'
import { _test } from './embeddings.ts'

const { bound, batchByTotalChars, EMBED_MAX_CHARS } = _test

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

/** Bounding each string is not enough: embedMany sends the batch as one request, and the server
 *  counts its tokens as a whole. This is the case that was still broken after the per-string cap. */
describe('batching by total size', () => {
  const total = (batch: string[]) => batch.reduce((n, s) => n + s.length, 0)

  it('keeps a small batch in a single call', () => {
    expect(batchByTotalChars(['a'.repeat(100), 'b'.repeat(100)], 4000)).toHaveLength(1)
  })

  it('splits the real indexing case — 18 chunks of 800 chars', () => {
    const chunks = Array.from({ length: 18 }, () => 'c'.repeat(800))
    const batches = batchByTotalChars(chunks, 4000)
    expect(batches.length).toBeGreaterThan(1)
    for (const b of batches) expect(total(b)).toBeLessThanOrEqual(4000)
  })

  it('loses nothing and preserves order, so vectors still line up with their chunks', () => {
    const values = Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(500, '.'))
    expect(batchByTotalChars(values, 4000).flat()).toEqual(values)
  })

  it('gives an already-capped value its own batch rather than dropping it', () => {
    const batches = batchByTotalChars(['x'.repeat(4000), 'y'.repeat(4000)], 4000)
    expect(batches).toHaveLength(2)
    expect(batches.flat()).toHaveLength(2)
  })

  it('handles an empty list', () => {
    expect(batchByTotalChars([], 4000)).toEqual([])
  })
})
