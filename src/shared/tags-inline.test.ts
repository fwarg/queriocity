import { describe, test, expect } from 'bun:test'
import { inlineTags, linkInlineTags } from './tags.ts'

describe('inline tags', () => {
  test('finds #tags in prose, nested and non-ASCII, and normalises them', () => {
    expect(inlineTags('About #ML/RAG and #svensk-historia.\n#ämne at a line start')).toEqual(['ml/rag', 'svensk-historia', 'ämne'])
  })

  test('ignores headings, numbers, anchors and code', () => {
    expect(inlineTags('# Heading\nIssue #12, see page#section and [x](#anchor). `#notatag`\n```\n#neither\n```')).toEqual([])
  })

  test('renders each as a link, leaving code alone', () => {
    expect(linkInlineTags('Read #ml/rag, not `#code`.', t => `#tag=${t}`)).toBe('Read [#ml/rag](#tag=ml/rag), not `#code`.')
  })
})
