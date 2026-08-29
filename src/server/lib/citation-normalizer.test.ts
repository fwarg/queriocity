import { describe, test, expect } from 'bun:test'
import { CitationNormalizer } from './citation-normalizer.ts'

/** Feed `text` through the normalizer in chunks of `size` chars, returning the concatenated
 *  output — the invariant is that chunking must not change the result. */
function run(text: string, size = text.length): string {
  const n = new CitationNormalizer()
  let out = ''
  for (let i = 0; i < text.length; i += size) out += n.process(text.slice(i, i + size))
  return out + n.flush()
}

describe('CitationNormalizer — grouped citations', () => {
  test('rewrites [1, 3] to [1][3] in the answer body', () => {
    expect(run('The throne passed to Haakon [1, 3] in 1905 [2].')).toBe(
      'The throne passed to Haakon [1][3] in 1905 [2].')
  })

  test('is unaffected by chunk boundaries splitting a group', () => {
    const text = 'A fact [1, 2] and another [3, 4, 5] here.\n'
    for (const size of [1, 2, 3, 7]) {
      expect(run(text, size)).toBe('A fact [1][2] and another [3][4][5] here.\n')
    }
  })

  test('leaves a normal answer with a ## Summary section intact', () => {
    const text = 'Intro paragraph [1].\n\n## Summary\n\nHaakon VIII now reigns [2][3].\n'
    expect(run(text)).toBe(text)
  })
})

describe('CitationNormalizer — trailing reference list', () => {
  test('drops a bare-[N] list with title lines, no heading', () => {
    const text = [
      'Following the death of King Harald V, Haakon VIII reigns [2][4].',
      '[2]',
      'King Harald V of Norway Has Died',
      '[4]',
      'Norway’s King Harald V dies at 89',
      '',
    ].join('\n')
    expect(run(text)).toBe('Following the death of King Harald V, Haakon VIII reigns [2][4].\n')
  })

  test('drops a ## Sources section', () => {
    const text = [
      'The monarchy continues under a new king [1].',
      '',
      '## Sources',
      '',
      '1. [Meet the royal family](https://example.com/a)',
      '2. [Royal family - Wikipedia](https://example.com/b)',
    ].join('\n')
    expect(run(text)).toBe('The monarchy continues under a new king [1].\n\n')
  })

  test('chunking does not change trailer removal', () => {
    const text = 'Body sentence [1][2].\n\n**Sources**\n[1]\nFirst title\n[2]\nSecond title\n'
    for (const size of [1, 4, 13]) {
      expect(run(text, size)).toBe('Body sentence [1][2].\n\n')
    }
  })

  test('keeps a lone [5] on its own line when real prose follows it', () => {
    const text = 'See here:\n[5]\nThis is still part of the answer and keeps going normally.\nAnd more.\n'
    expect(run(text)).toBe(text)
  })

  test('keeps a single bare [N] + line at the very end (not confidently a reference list)', () => {
    const text = 'The answer body [1].\n[1]\nA single trailing line.\n'
    expect(run(text)).toBe(text)
  })

  test('keeps content when the answer simply ends mid-sentence with no newline', () => {
    expect(run('The final unterminated sentence [3]')).toBe('The final unterminated sentence [3]')
  })
})
