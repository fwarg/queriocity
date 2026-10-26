import { embedTexts, embedPrefix } from '../embeddings.ts'
import { modelTarget, targetLabel } from '../llm.ts'
import { listTags } from './tags.ts'
import { cosineSimilarity } from './topic-cluster.ts'
import { tagMatchSimilarity, tagPlaceSimilarity } from '../rag-settings.ts'
import { normaliseTag, tagAncestry, isUnder, parentOf } from '../../../shared/tags.ts'

/** Tag suggestions for a resource: the small model's topics, each mapped onto a tag the user already
 *  has where one fits, so the tree grows from what is there rather than from free words. A topic
 *  matches by path, by a tag's last segment (`roses` → `plants/roses`), or by meaning; one only
 *  related to a tag is placed beside it (`tulips` → `plants/tulips`); the rest are offered as new
 *  top-level tags. Suggestions only: nothing is tagged until the user taps. */

export interface TagSuggestion { path: string; existing: boolean }

/** Tags compared by meaning: the most used, as topic naming takes them. */
const MAX_COMPARED_TAGS = 200

/** Vectors of tags and topics by embedding model and phrase: both are short and change rarely, so
 *  opening a resource seldom waits for the embedding server. Cleared, not evicted, when full. */
const phraseVectors = new Map<string, number[]>()
const MAX_CACHED_PHRASES = 5000

/** The topics as suggestions, existing tags first, minus what the resource carries or implies. */
export async function suggestedTags(userId: string, topics: string[], tags: string[]): Promise<TagSuggestion[]> {
  const known = knownTags(userId)
  const wanted = [...new Set(topics.map(normaliseTag).filter(Boolean))]
  const matched = new Map<string, string>()
  const placed = new Map<string, string>()
  for (const topic of wanted) {
    const path = lexicalMatch(topic, known)
    if (path) matched.set(topic, path)
  }
  const unmatched = wanted.filter(topic => !matched.has(topic))
  if (unmatched.length && known.length) {
    const [match, place] = await Promise.all([tagMatchSimilarity(), tagPlaceSimilarity()])
    try {
      for (const [topic, [path, similarity]] of await nearestTags(unmatched, known)) {
        const beside = similarity < match && similarity >= place ? placement(topic, path, known) : null
        if (similarity >= match) matched.set(topic, path)
        if (beside) placed.set(topic, beside)
        console.log(`  [tags] topic "${topic}" ${similarity >= match ? '→' : beside ? `placed as #${beside} beside` : 'new, nearest'} #${path} (similarity ${similarity.toFixed(3)}, match ${match}, place ${place})`)
      }
    } catch (e) {
      console.warn(`  [tags] matching topics by meaning failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  const carried = (path: string) => tags.some(tag => isUnder(tag, path))
  const existing = [...new Set(matched.values())].filter(p => !carried(p))
  const fresh = [...new Set(unmatched.filter(t => !matched.has(t)).map(t => placed.get(t) ?? t))].filter(p => !carried(p))
  return [...existing.map(path => ({ path, existing: true })), ...fresh.map(path => ({ path, existing: false }))]
}

/** Where a new topic goes beside its nearest tag: under it when it already has sub-tags (it is a
 *  category), else under its parent. Null for a nested topic or a top-level leaf, which give no place. */
function placement(topic: string, nearest: string, known: string[]): string | null {
  if (topic.includes('/')) return null
  const parent = known.some(p => p.startsWith(`${nearest}/`)) ? nearest : parentOf(nearest)
  return parent ? `${parent}/${topic}` : null
}

/** Every path the user's tags give, parents included, most used first. */
function knownTags(userId: string): string[] {
  const counts = new Map<string, number>()
  for (const { path, count } of listTags(userId)) {
    for (const p of tagAncestry(path)) counts.set(p, (counts.get(p) ?? 0) + count)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([path]) => path)
}

/** The tag a topic names outright: the same path, else the most used tag ending in it. */
function lexicalMatch(topic: string, known: string[]): string | null {
  if (known.includes(topic)) return topic
  const leaf = topic.split('/').pop()!
  return known.find(path => path.split('/').pop() === leaf) ?? null
}

/** The nearest tag in meaning to each topic, with its cosine similarity. */
async function nearestTags(topics: string[], known: string[]): Promise<Map<string, [string, number]>> {
  const compared = known.slice(0, MAX_COMPARED_TAGS)
  const [vectors, topicVectors] = [await vectorsFor(compared), await vectorsFor(topics)]
  const out = new Map<string, [string, number]>()
  topics.forEach((topic, i) => {
    let best: [string, number] = ['', -1]
    compared.forEach((path, j) => {
      const s = cosineSimilarity(topicVectors[i], vectors[j])
      if (s > best[1]) best = [path, s]
    })
    if (best[0]) out.set(topic, best)
  })
  return out
}

/** Pairs of tags at least `floor` alike in meaning, most alike first: hints for tidying. */
export async function similarTagPairs(paths: string[], floor: number): Promise<Array<[string, string]>> {
  const vectors = await vectorsFor(paths)
  const pairs: Array<[string, string, number]> = []
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (isUnder(paths[j], paths[i]) || isUnder(paths[i], paths[j])) continue
      const s = cosineSimilarity(vectors[i], vectors[j])
      if (s >= floor) pairs.push([paths[i], paths[j], s])
    }
  }
  return pairs.sort((a, b) => b[2] - a[2]).map(([a, b]) => [a, b])
}

async function vectorsFor(paths: string[]): Promise<number[][]> {
  const model = `${targetLabel(modelTarget('embed'))}\n${embedPrefix('similarity')}`
  const key = (path: string) => `${model}\n${asPhrase(path)}`
  if (phraseVectors.size + paths.length > MAX_CACHED_PHRASES) phraseVectors.clear()
  const missing = [...new Set(paths.filter(p => !phraseVectors.has(key(p))))]
  if (missing.length) {
    const vectors = await embedTexts(missing.map(asPhrase), 'similarity')
    vectors.forEach((v, i) => phraseVectors.set(key(missing[i]), v))
  }
  return paths.map(p => phraseVectors.get(key(p))!)
}

/** `plants/garden-roses` → `plants garden roses`: the words an embedding model reads best. */
const asPhrase = (path: string) => path.replace(/[/-]+/g, ' ')
