import { embedTexts } from '../embeddings.ts'
import { modelTarget, targetLabel } from '../llm.ts'
import { listTags } from './tags.ts'
import { cosineSimilarity } from './topic-cluster.ts'
import { normaliseTag, tagAncestry, isUnder } from '../../../shared/tags.ts'

/** Tag suggestions for a resource: the small model's topics, each mapped onto a tag the user already
 *  has where one fits, so the tree grows from what is there rather than from free words. A topic
 *  matches by path, by a tag's last segment (`roses` → `plants/roses`), or by meaning; the rest are
 *  offered as new tags. Suggestions only: nothing is tagged until the user taps. */

export interface TagSuggestion { path: string; existing: boolean }

/** A topic this close in meaning to a tag is offered as that tag. A guess for one-to-three-word
 *  phrases, where embeddings are noisy: each match is logged so it can be tuned on a real library. */
const TAG_MATCH_SIMILARITY = 0.8
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
  const matched = new Map(wanted.map(topic => [topic, lexicalMatch(topic, known)]))
  const unmatched = wanted.filter(topic => !matched.get(topic))
  if (unmatched.length && known.length) {
    try {
      for (const [topic, path] of await semanticMatches(unmatched, known)) matched.set(topic, path)
    } catch (e) {
      console.warn(`  [tags] matching topics by meaning failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  const carried = (path: string) => tags.some(tag => isUnder(tag, path))
  const existing = [...new Set([...matched.values()].filter((p): p is string => !!p))].filter(p => !carried(p))
  const fresh = wanted.filter(topic => !matched.get(topic) && !carried(topic))
  return [...existing.map(path => ({ path, existing: true })), ...fresh.map(path => ({ path, existing: false }))]
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

/** The nearest tag in meaning for each topic close enough to one. */
async function semanticMatches(topics: string[], known: string[]): Promise<Map<string, string>> {
  const compared = known.slice(0, MAX_COMPARED_TAGS)
  const [vectors, topicVectors] = [await vectorsFor(compared), await vectorsFor(topics)]
  const out = new Map<string, string>()
  topics.forEach((topic, i) => {
    let best: [string, number] = ['', -1]
    compared.forEach((path, j) => {
      const s = cosineSimilarity(topicVectors[i], vectors[j])
      if (s > best[1]) best = [path, s]
    })
    if (best[1] >= TAG_MATCH_SIMILARITY) {
      console.log(`  [tags] topic "${topic}" → #${best[0]} (similarity ${best[1].toFixed(3)}, min ${TAG_MATCH_SIMILARITY})`)
      out.set(topic, best[0])
    }
  })
  return out
}

async function vectorsFor(paths: string[]): Promise<number[][]> {
  const model = targetLabel(modelTarget('embed'))
  const key = (path: string) => `${model}\n${asPhrase(path)}`
  if (phraseVectors.size + paths.length > MAX_CACHED_PHRASES) phraseVectors.clear()
  const missing = [...new Set(paths.filter(p => !phraseVectors.has(key(p))))]
  if (missing.length) {
    const vectors = await embedTexts(missing.map(asPhrase))
    vectors.forEach((v, i) => phraseVectors.set(key(missing[i]), v))
  }
  return paths.map(p => phraseVectors.get(key(p))!)
}

/** `plants/garden-roses` → `plants garden roses`: the words an embedding model reads best. */
const asPhrase = (path: string) => path.replace(/[/-]+/g, ' ')
