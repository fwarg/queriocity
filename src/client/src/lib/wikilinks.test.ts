import { describe, test, expect } from 'bun:test'
import { wikilinksToMarkdown, wikilinkTitle, wikilinkFor } from './wikilinks.ts'

describe('wikilinksToMarkdown', () => {
  test('turns titles and aliases into fragment links that round-trip', () => {
    const md = wikilinksToMarkdown('See [[Bees (insects)]] and [[Hives|the hives]].')
    expect(md).toBe('See [Bees (insects)](#wikilink=Bees%20%28insects%29) and [the hives](#wikilink=Hives).')
    expect(wikilinkTitle('#wikilink=Bees%20%28insects%29')).toBe('Bees (insects)')
  })

  test('leaves code alone', () => {
    const body = 'Use `[[x]]` literally.\n```\n[[y]]\n```\nBut [[z]] links.'
    expect(wikilinksToMarkdown(body)).toBe('Use `[[x]]` literally.\n```\n[[y]]\n```\nBut [z](#wikilink=z) links.')
  })

  test('ignores ordinary hrefs and builds insertable links', () => {
    expect(wikilinkTitle('https://example.com')).toBeNull()
    expect(wikilinkFor('A [draft] | v2')).toBe('[[A draft v2]]')
  })
})
