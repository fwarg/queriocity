import { describe, test, expect } from 'bun:test'
import { buildTagTree } from './tag-tree.ts'

describe('buildTagTree', () => {
  test('nests paths, adds parents nobody carries, and counts each resource once per subtree', () => {
    const tree = buildTagTree([{ tags: ['ml/rag'] }, { tags: ['ml/rag', 'ml/agents'] }, { tags: ['ml'] }, { tags: ['tax'] }, { tags: [] }])
    expect(tree.map(n => [n.path, n.own, n.total])).toEqual([['ml', 1, 3], ['tax', 1, 1]])
    expect(tree[0].children.map(n => [n.name, n.own, n.total])).toEqual([['agents', 1, 1], ['rag', 2, 2]])
  })

  test('a prefix that is not a parent stays separate', () => {
    expect(buildTagTree([{ tags: ['ml'] }, { tags: ['mlops'] }]).map(n => [n.path, n.total])).toEqual([['ml', 1], ['mlops', 1]])
  })
})
