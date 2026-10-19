import { generateText } from 'ai'
import { getSmallModel } from '../llm.ts'
import { listTags } from './tags.ts'
import { similarTagPairs } from './tag-suggestions.ts'
import { tagMatchSimilarity } from '../rag-settings.ts'
import { isUnder, normaliseTag, tagAncestry } from '../../../shared/tags.ts'

/** "Tidy tags": the small model reads the user's tag tree and proposes renames that make it more
 *  consistent — merging synonyms, nesting a tag under the one it belongs to, grouping siblings under
 *  a new parent. Proposals only: each is applied, if the user ticks it, as an ordinary rename. Tags
 *  close in meaning are found by embedding first and handed over as hints, so a weak local model
 *  mostly has to judge pairs rather than find them. */

export interface TagChange {
  from: string
  to: string
  /** Resources carrying `from` or anything under it. */
  count: number
  /** `to` already exists, so the two merge. */
  merges: boolean
}

const MAX_CHANGES = 15
/** Tags shown to the model: the most used, as topic naming takes them. */
const MAX_TIDY_TAGS = 300
const MAX_HINT_PAIRS = 40

const TIDY_SYSTEM = `You tidy the tag tree of a personal knowledge base. Tags are lowercase and nest with / (plants/roses).
Propose at most ${MAX_CHANGES} changes that make the tree more consistent:
- merge tags that mean the same — synonyms, singular and plural, the same word in another language — into the more used one;
- move a top-level tag under an existing tag it belongs to (roses -> plants/roses);
- group three or more related top-level tags under a new parent (roses, tulips -> plants/roses, plants/tulips).
Change only what clearly improves the tree; fewer is better, and none is a fine answer. Keep each tag's language.
Reply with one change per line as \`old -> new\` and nothing else, or NONE.`

/** Proposed renames for the user's tags; throws when the model fails. */
export async function proposeTagTidy(userId: string): Promise<TagChange[]> {
  const tags = listTags(userId)
  const totals = new Map<string, number>()
  for (const { path, count } of tags) for (const p of tagAncestry(path)) totals.set(p, (totals.get(p) ?? 0) + count)
  if (totals.size < 2) return []
  const shown = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_TIDY_TAGS)
  const pairs = await similarTagPairs(shown.map(([path]) => path), await tagMatchSimilarity()).catch(e => {
    console.warn(`  [tags] no similar-tag hints for tidying: ${e instanceof Error ? e.message : e}`)
    return [] as Array<[string, string]>
  })
  const hints = pairs.slice(0, MAX_HINT_PAIRS).map(([a, b]) => `- ${a} ~ ${b}`).join('\n')
  const { text } = await generateText({
    model: getSmallModel(),
    system: TIDY_SYSTEM,
    prompt: `TAGS (resources carrying each, sub-tags included):\n${shown.map(([p, n]) => `- ${p} (${n})`).join('\n')}`
      + (hints ? `\n\nPOSSIBLY THE SAME (judge these first):\n${hints}` : ''),
    maxOutputTokens: 600,
    abortSignal: AbortSignal.timeout(60_000),
  })
  return parseTagChanges(text, totals)
}

/** `old -> new` lines that rename an existing tag somewhere valid. A change touching a tag an earlier
 *  one moves or creates is dropped, so applying them in order never undoes or strands another. */
export function parseTagChanges(text: string, totals: Map<string, number>): TagChange[] {
  const changes: TagChange[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?#?(.+?)\s*(?:->|→)\s*#?(.+?)\s*$/.exec(line)
    if (!m) continue
    const [from, to] = [normaliseTag(m[1]), normaliseTag(m[2])]
    if (!from || !to || from === to || !totals.has(from) || isUnder(to, from)) continue
    const overlaps = (a: string, b: string) => isUnder(a, b) || isUnder(b, a)
    if (changes.some(c => overlaps(from, c.from) || overlaps(from, c.to) || overlaps(to, c.from))) continue
    changes.push({ from, to, count: totals.get(from)!, merges: totals.has(to) })
    if (changes.length === MAX_CHANGES) break
  }
  return changes
}
