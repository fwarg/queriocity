import { describe, test, expect, beforeEach } from 'bun:test'
import { ThinkExtractor } from './think-extractor.ts'

// ThinkExtractor buffers the last N chars to handle partial tags spanning chunks.
// process() emits safe (fully-resolved) output; flush() drains the remainder.

describe('ThinkExtractor', () => {
  let ext: ThinkExtractor

  beforeEach(() => { ext = new ThinkExtractor() })

  test('passes plain text through (keeps last 6 chars buffered)', () => {
    const r = ext.process('hello world')
    expect(r).toEqual({ text: 'hello', thinking: '' })
    expect(ext.flush()).toEqual({ text: ' world', thinking: '' })
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

  test('handles multiple think blocks in one chunk', () => {
    const r = ext.process('<think>a</think>mid<think>b</think>end')
    expect(r.thinking).toBe('ab')
    expect(r.text).toBe('mid')
    expect(ext.flush()).toEqual({ text: 'end', thinking: '' })
  })
})
