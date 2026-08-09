import { describe, test, expect, beforeEach } from 'bun:test'
import { ThinkExtractor } from './think-extractor.ts'

// ThinkExtractor buffers the last N chars to handle partial tags spanning chunks.
// process() emits safe (fully-resolved) output; flush() drains the remainder.

describe('ThinkExtractor', () => {
  let ext: ThinkExtractor

  beforeEach(() => { ext = new ThinkExtractor() })

  // The hold-back is one short of the longest opening tag, so a tag split across deltas is still
  // recognised. '<tool_call>' is the longest, hence 10.
  test('passes plain text through (keeps last 10 chars buffered)', () => {
    const r = ext.process('hello there world')
    expect(r).toEqual({ text: 'hello t', thinking: '' })
    expect(ext.flush()).toEqual({ text: 'here world', thinking: '' })
  })

  test('extracts think block in a single chunk', () => {
    const r = ext.process('before<think>thought</think>after')
    expect(r.text).toBe('before')
    expect(r.thinking).toBe('thought')
    expect(ext.flush()).toEqual({ text: 'after', thinking: '' })
  })

  test('handles think tag split across chunks', () => {
    ext.process('be<thi')
    ext.process('nk>thoug')
    const r = ext.process('ht</think>end')
    expect(r.thinking).toContain('thought')
    expect(ext.flush().text).toBe('end')
  })

  test('flush returns buffered text when no think tag', () => {
    ext.process('hi')
    expect(ext.flush()).toEqual({ text: 'hi', thinking: '' })
  })

  test('flush returns buffered content as thinking when inside think tag', () => {
    ext.process('<think>partial')
    expect(ext.flush()).toEqual({ text: '', thinking: 'partial' })
  })

  // A model whose tools were withheld may write the call out as prose. Nothing downstream parses
  // it, so without this it reaches the user as the answer — the bug seen on 2026-08-05.
  describe('leaked tool-call markup', () => {
    test('is dropped, and the prose around it is kept', () => {
      const r = ext.process('Here is what I found.<tool_call>\n{"name": "web_search"}\n</tool_call>Done.')
      expect(r.text).toBe('Here is what I found.')
      expect(r.thinking).toBe('')
      expect(ext.flush()).toEqual({ text: 'Done.', thinking: '' })
    })

    test('is dropped when split across deltas', () => {
      // Asserted on the concatenation, not per delta: where the hold-back lands mid-word is an
      // implementation detail, but no part of the block may ever surface.
      const deltas = ['answer', '<tool', '_call><function=web_search>', '</function></tool_call>', 'tail']
      const text = deltas.reduce((acc, d) => acc + ext.process(d).text, '') + ext.flush().text

      expect(text).toBe('answertail')
    })

    test('an unterminated block is dropped rather than leaked by flush', () => {
      ext.process('<tool_call><function=web_search>')
      expect(ext.flush()).toEqual({ text: '', thinking: '' })
    })
  })

  test('handles multiple think blocks in one chunk', () => {
    const r = ext.process('<think>a</think>mid<think>b</think>end')
    expect(r.thinking).toBe('ab')
    expect(r.text).toBe('mid')
    expect(ext.flush()).toEqual({ text: 'end', thinking: '' })
  })
})
