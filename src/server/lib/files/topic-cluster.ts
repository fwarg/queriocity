/** Agglomerative clustering, average linkage over cosine similarity, cut at a threshold. Pure, so
 *  it can be tested on fixed vectors.
 *
 *  Uses the nearest-neighbour chain: follow each cluster's most similar neighbour until two are
 *  each other's nearest, merge those, repeat — O(n²) time on an n×n similarity matrix. A cluster
 *  whose nearest neighbour falls below the threshold is final: average linkage is reducible, so a
 *  merge elsewhere can never bring anything closer to it. Ties go to the lower index, which makes
 *  the result depend only on the input order. */
export function clusterBySimilarity(vectors: ArrayLike<number>[], threshold: number): number[][] {
  const n = vectors.length
  const sim = similarityMatrix(vectors)
  const members: number[][] = vectors.map((_, i) => [i])
  const active = new Set(members.map((_, i) => i))
  const done: number[] = []
  const chain: number[] = []

  const nearest = (a: number): [number, number] => {
    let best = -1
    let bestSim = -Infinity
    for (const c of active) if (c !== a && sim[a * n + c] > bestSim) { best = c; bestSim = sim[a * n + c] }
    return [best, bestSim]
  }

  while (active.size > 1) {
    if (!chain.length) chain.push(Math.min(...active))
    const a = chain[chain.length - 1]
    const [b, s] = nearest(a)
    if (s < threshold) {
      // Nothing is similar enough to `a`, now or after any later merge: it is finished.
      active.delete(a)
      done.push(a)
      chain.length = 0
      continue
    }
    if (chain.length >= 2 && chain[chain.length - 2] === b) {
      chain.length -= 2
      merge(sim, n, members, active, Math.min(a, b), Math.max(a, b))
    } else {
      chain.push(b)
    }
  }
  return [...done, ...active].map(i => members[i])
}

/** Folds cluster `b` into `a`, updating average-linkage similarities (Lance–Williams). */
function merge(sim: Float32Array, n: number, members: number[][], active: Set<number>, a: number, b: number): void {
  const [na, nb] = [members[a].length, members[b].length]
  for (const c of active) {
    if (c === a || c === b) continue
    const s = (na * sim[a * n + c] + nb * sim[b * n + c]) / (na + nb)
    sim[a * n + c] = s
    sim[c * n + a] = s
  }
  members[a] = [...members[a], ...members[b]]
  active.delete(b)
}

/** Cosine similarity of every pair, as a flat n×n matrix. */
export function similarityMatrix(vectors: ArrayLike<number>[]): Float32Array {
  const n = vectors.length
  const norms = vectors.map(v => Math.sqrt(dot(v, v)) || 1)
  const sim = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    sim[i * n + i] = 1
    for (let j = i + 1; j < n; j++) {
      const s = dot(vectors[i], vectors[j]) / (norms[i] * norms[j])
      sim[i * n + j] = s
      sim[j * n + i] = s
    }
  }
  return sim
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
