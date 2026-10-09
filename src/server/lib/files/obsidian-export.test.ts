import { describe, test, expect } from 'bun:test'
import { fileNames, joinChunks, relink } from './obsidian-export.ts'

describe('Obsidian export helpers', () => {
  test('file names drop unsafe characters and number clashes', () => {
    expect(fileNames(['A/B', 'A B', 'a b', 'C#?', ''])).toEqual(['A B', 'A B (2)', 'a b (3)', 'C', 'Untitled'])
  })

  test('links follow renamed files, keeping the label', () => {
    const names = new Map([['a/b', 'A B'], ['plain', 'Plain']])
    expect(relink('[[A/B]], [[a/b|x]], [[Plain]], [[Missing]]', names)).toBe('[[A B|A/B]], [[A B|x]], [[Plain]], [[Missing]]')
  })

  test('overlapping chunks join without repeating the seam', () => {
    const seam = 'the shared overlap of twenty-plus chars'
    expect(joinChunks([`Start. ${seam}`, `${seam} end.`, 'Unrelated next.'])).toBe(`Start. ${seam} end.\n\nUnrelated next.`)
  })
})
