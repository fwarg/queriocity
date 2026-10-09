import { createHash } from 'node:crypto'
import { generateText } from 'ai'
import { sqlite } from '../db.ts'
import { getSmallModel } from '../llm.ts'
import { resourceVector } from './related.ts'
import { linkCounts } from './graph.ts'
import { listTags, tagsByResource } from './tags.ts'
import { normaliseTag, tagAncestry } from '../../../shared/tags.ts'
import { clusterBySimilarity, similarityMatrix } from './topic-cluster.ts'

/** The topic map: a user's notes (optionally all resources) grouped by content, with what each group
 *  says about how organised it is. Nothing is stored but the names, so topics follow the library as
 *  it changes. */

/** Smaller groups are not topics; their notes are listed as not in any. */
export const MIN_TOPIC_SIZE = 3
/** Most recent resources clustered; the similarity matrix grows with the square of this. */
export const MAX_TOPIC_RESOURCES = 2500
/** Two members this similar are probably the same note twice. */
const DUPLICATE_SIMILARITY = 0.95
/** Members shown to the model when naming a topic. */
const NAMING_SAMPLE = 10

export interface TopicMember { id: string; title: string; kind: 'file' | 'note' }

export interface Topic {
  /** Hash of the member ids: identifies the topic for naming and its cache. */
  key: string
  members: TopicMember[]
  /** Cached name and suggested tag, when this exact topic was named before. */
  name?: string
  tag?: string | null
  /** The tag covering most members (counting tags under it), with how many it covers. */
  topTag: { path: string; count: number } | null
  /** Distinct top-level tags among the members — many means the tags do not match the content. */
  tagSpread: number
  unlinked: number
  duplicates: Array<[string, string]>
}

export interface TopicMap {
  topics: Topic[]
  /** Resources in no topic: alone, or in a group smaller than MIN_TOPIC_SIZE. */
  loose: TopicMember[]
  threshold: number
  /** Resources considered, after the cap; `capped` when there were more. */
  considered: number
  capped: boolean
}

export const topicKey = (ids: string[]) => createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 24)

/** Groups the user's notes (or all resources) whose average similarity reaches `threshold`. */
export function topicMap(userId: string, threshold: number, { includeFiles = false } = {}): TopicMap {
  const rows = sqlite.query(`
    SELECT id, filename AS title, kind FROM uploaded_files
    WHERE user_id = ? ${includeFiles ? '' : "AND kind = 'note'"} ORDER BY created_at DESC LIMIT ?
  `).all(userId, MAX_TOPIC_RESOURCES + 1) as TopicMember[]
  const capped = rows.length > MAX_TOPIC_RESOURCES
  const withVectors = rows.slice(0, MAX_TOPIC_RESOURCES).flatMap(r => {
    const v = resourceVector(r.id)
    return v ? [{ member: r, vector: v }] : []
  })
  const vectors = withVectors.map(w => w.vector)
  const groups = clusterBySimilarity(vectors, threshold)
  const tags = tagsByResource(userId)
  const links = linkCounts(userId)
  const names = cachedNames(userId)
  const topics = groups.filter(g => g.length >= MIN_TOPIC_SIZE)
    .map(g => describeTopic(g.map(i => withVectors[i].member), g.map(i => vectors[i]), tags, links, names))
    .sort((a, b) => b.members.length - a.members.length)
  const loose = groups.filter(g => g.length < MIN_TOPIC_SIZE).flat().map(i => withVectors[i].member)
  return { topics, loose, threshold, considered: withVectors.length, capped }
}

function describeTopic(
  members: TopicMember[], vectors: number[][], tags: Map<string, string[]>, links: Map<string, number>,
  names: Map<string, { name: string; tag: string | null }>,
): Topic {
  const key = topicKey(members.map(m => m.id))
  const coverage = new Map<string, number>()
  const topLevels = new Set<string>()
  for (const m of members) {
    const own = tags.get(m.id) ?? []
    for (const path of new Set(own.flatMap(tagAncestry))) coverage.set(path, (coverage.get(path) ?? 0) + 1)
    for (const path of own) topLevels.add(path.split('/')[0])
  }
  // Most members first; among equals the deeper, more specific tag.
  const best = [...coverage].sort((a, b) => b[1] - a[1] || b[0].split('/').length - a[0].split('/').length || a[0].localeCompare(b[0]))[0]
  const sim = similarityMatrix(vectors)
  const n = members.length
  const duplicates: Array<[string, string]> = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (sim[i * n + j] >= DUPLICATE_SIMILARITY) duplicates.push([members[i].id, members[j].id])
  }
  return {
    key,
    members,
    ...(names.has(key) ? names.get(key) : {}),
    topTag: best ? { path: best[0], count: best[1] } : null,
    tagSpread: topLevels.size,
    unlinked: members.filter(m => m.kind === 'note' && !links.get(m.id)).length,
    duplicates,
  }
}

function cachedNames(userId: string): Map<string, { name: string; tag: string | null }> {
  const rows = sqlite.query('SELECT key, name, tag FROM topic_names WHERE user_id = ?').all(userId) as Array<{ key: string; name: string; tag: string | null }>
  return new Map(rows.map(r => [r.key, { name: r.name, tag: r.tag }]))
}

const NAMING_SYSTEM = `You name a group of related notes from a personal knowledge base.
Reply with exactly two lines and nothing else:
name: a 2-4 word name for what the notes have in common, in their language
tag: one lowercase tag for them (use / to nest); reuse one of the EXISTING TAGS if one fits`

/** A name and suggested tag for a topic of the user's resources, from the cache or the small model.
 *  Falls back to the most common tag, or the first title, when the model fails. */
export async function nameTopic(userId: string, ids: string[]): Promise<{ key: string; name: string; tag: string | null }> {
  const marks = ids.map(() => '?').join(',')
  const rows = sqlite.query(`SELECT id, filename AS title, summary FROM uploaded_files WHERE user_id = ? AND id IN (${marks})`)
    .all(userId, ...ids) as Array<{ id: string; title: string; summary: string | null }>
  if (rows.length !== new Set(ids).size) throw new Error('Not found')
  // In the caller's order: the first member is the fallback name and leads the sample.
  rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
  const key = topicKey(ids)
  const cached = cachedNames(userId).get(key)
  if (cached) return { key, ...cached }

  const known = listTags(userId).sort((a, b) => b.count - a.count).slice(0, 150).map(t => t.path)
  const sample = rows.slice(0, NAMING_SAMPLE).map(r => `- ${r.title}${r.summary ? ` — ${r.summary}` : ''}`).join('\n')
  let named: { name: string; tag: string | null }
  try {
    const { text } = await generateText({
      model: getSmallModel(),
      system: NAMING_SYSTEM,
      prompt: `${known.length ? `EXISTING TAGS: ${known.join(', ')}\n\n` : ''}NOTES:\n${sample}`,
      maxOutputTokens: 60,
      abortSignal: AbortSignal.timeout(30_000),
    })
    const name = /^name:\s*(.+)$/im.exec(text)?.[1].trim()
    const tag = normaliseTag(/^tag:\s*(.+)$/im.exec(text)?.[1] ?? '') || null
    if (!name) throw new Error('no name in reply')
    named = { name: name.replace(/^["']|["']$/g, ''), tag }
  } catch (e) {
    console.warn(`  [topics] naming failed, using a fallback: ${e instanceof Error ? e.message : e}`)
    return { key, name: rows[0].title, tag: null }
  }
  sqlite.run('INSERT OR REPLACE INTO topic_names (user_id, key, name, tag) VALUES (?, ?, ?, ?)', [userId, key, named.name, named.tag])
  return { key, ...named }
}
