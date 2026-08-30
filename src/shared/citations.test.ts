import { describe, test, expect } from 'bun:test'
import { splitGroupedCitations } from './citations.ts'

describe('splitGroupedCitations', () => {
  test('splits comma-separated groups into single-token citations', () => {
    expect(splitGroupedCitations('the throne [1, 3] passed')).toBe('the throne [1][3] passed')
    expect(splitGroupedCitations('[1,2,3]')).toBe('[1][2][3]')
    expect(splitGroupedCitations('[4; 5]')).toBe('[4][5]')
    expect(splitGroupedCitations('[7,  9]')).toBe('[7][9]')
  })

  test('leaves canonical and non-citation brackets untouched', () => {
    expect(splitGroupedCitations('one [1] two [2][3]')).toBe('one [1] two [2][3]')
    expect(splitGroupedCitations('resource [F1] and [C2]')).toBe('resource [F1] and [C2]')
    expect(splitGroupedCitations('- [ ] todo\n- [x] done')).toBe('- [ ] todo\n- [x] done')
    expect(splitGroupedCitations('array[1, 2]')).toBe('array[1][2]') // still a group; acceptable
  })

  test('handles multiple groups in one string', () => {
    expect(splitGroupedCitations('a [1, 2] b [3, 4, 5] c')).toBe('a [1][2] b [3][4][5] c')
  })
})
