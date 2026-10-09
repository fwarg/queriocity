import { describe, test, expect } from 'bun:test'
import { centroid, clusterBySimilarity, nearestPairs } from './topic-cluster.ts'

const sorted = (groups: number[][]) => groups.map(g => [...g].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])

describe('clusterBySimilarity', () => {
  // Two tight groups along different axes, and one loner between them.
  const vectors = [[1, 0.05, 0], [1, 0, 0.05], [0.95, 0.1, 0], [0, 1, 0.05], [0.05, 1, 0], [0, 0.95, 0.1], [0, 0, 1]]

  test('groups what is similar and leaves the rest alone', () => {
    expect(sorted(clusterBySimilarity(vectors, 0.9))).toEqual([[0, 1, 2], [3, 4, 5], [6]])
  })

  test('a lower threshold merges more; one at 1 merges nothing', () => {
    expect(clusterBySimilarity(vectors, 0).length).toBe(1)
    expect(clusterBySimilarity(vectors, 1.01).length).toBe(7)
  })

  test('is deterministic', () => {
    expect(sorted(clusterBySimilarity(vectors, 0.5))).toEqual(sorted(clusterBySimilarity(vectors, 0.5)))
  })

  test('handles zero or one vector', () => {
    expect(clusterBySimilarity([], 0.5)).toEqual([])
    expect(clusterBySimilarity([[1, 0]], 0.5)).toEqual([[0]])
  })
})

describe('nearestPairs', () => {
  const vectors = [[1, 0], [0.99, 0.1], [0.98, 0.2], [0, 1]]

  test('joins each to its nearest above the floor, each pair once', () => {
    expect(nearestPairs(vectors, 1, 0.5).map(([a, b]) => [a, b])).toEqual([[0, 1], [1, 2]])
  })

  test('the floor keeps an unrelated item alone', () => {
    expect(nearestPairs(vectors, 3, 0.5).some(([a, b]) => a === 3 || b === 3)).toBe(false)
  })

  test('a centroid is the normalised mean', () => {
    const [x, y] = centroid([[1, 0], [0, 1]])
    expect([x.toFixed(3), y.toFixed(3)]).toEqual(['0.707', '0.707'])
  })
})
