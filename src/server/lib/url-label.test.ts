import { describe, expect, test } from 'bun:test'
import { urlLabel } from './fetch-url.ts'

/** The label an ingested page carries in the library and in every citation that quotes it. It lives
 *  in the `filename` column but is never written to disk, so it is a title rather than a filename. */
describe('urlLabel', () => {
  test('keeps the whole path, separated from the host', () => {
    // The bug: host and last segment were concatenated with nothing between, and the middle of the
    // path was dropped — "github.comopen-notebook.txt".
    expect(urlLabel('https://github.com/lfnovo/open-notebook')).toBe('github.com/lfnovo/open-notebook')
  })

  test('distinguishes two pages that share a last path segment', () => {
    const a = urlLabel('https://github.com/alice/toolkit')
    const b = urlLabel('https://github.com/bob/toolkit')
    expect(a).not.toBe(b)
  })

  test('drops the scheme, a www prefix and a trailing slash', () => {
    expect(urlLabel('https://www.example.com/articles/one/')).toBe('example.com/articles/one')
  })

  test('reduces a bare host to the host', () => {
    expect(urlLabel('https://example.com/')).toBe('example.com')
    expect(urlLabel('https://example.com')).toBe('example.com')
  })

  test('keeps a query string, which often carries the whole identity of the page', () => {
    expect(urlLabel('https://example.com/view?id=42')).toBe('example.com/view?id=42')
  })

  test('names a YouTube video by its id, whatever URL form it arrived in', () => {
    // A transcript is not a page, and every YouTube URL form points at the same recording.
    expect(urlLabel('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('YouTube dQw4w9WgXcQ')
    expect(urlLabel('https://youtu.be/dQw4w9WgXcQ')).toBe('YouTube dQw4w9WgXcQ')
  })

  test('bounds the length, so one long URL cannot swamp a list row', () => {
    expect(urlLabel(`https://example.com/${'segment/'.repeat(60)}`).length).toBeLessThanOrEqual(120)
  })

  test('falls back to the raw string rather than throwing on an unparseable URL', () => {
    expect(urlLabel('not a url')).toBe('not a url')
  })
})
