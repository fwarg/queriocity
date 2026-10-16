import { createHash } from 'node:crypto'
import { generateText } from 'ai'
import { sqlite } from '../db.ts'
import { languageModel, outputCap, type ModelTarget } from '../llm.ts'
import { LANGUAGE_RULE } from './transforms.ts'
import { digestOf, mapInputChars, modelKey, withoutThinking } from './collection-digests.ts'
import type { CollectionDoc } from './collection-coverage.ts'

/** Task-aware extracts: each document read for the task at hand — the user's message, and the card of
 *  a draft they attached — rather than summarised the same way for every question. The answer is then
 *  written from what every document says about the task (map → reduce). A document longer than one
 *  call can read is read in consecutive parts. Extracts are cached per document, model and task, so a
 *  retry costs nothing; the generic digest stands in when an extract cannot be made. */

const EXTRACT_MAX_CHARS = 2000
const EXTRACT_MAX_TOKENS = 1200
const DRAFT_CARD_MAX_CHARS = 1500
const DRAFT_CARD_MAX_TOKENS = 1000
/** Newest extracts kept per document; older tasks' extracts are pruned. */
const EXTRACTS_KEPT_PER_DOC = 20
/** What a document with nothing on the task answers with; the answer lists it as read but empty. */
const NOTHING_RELEVANT = 'NOTHING RELEVANT'

const EXTRACT_SYSTEM = `You read one document from a collection for a task the user gave. Another step combines what you write with the same from every other document, so extract from this one only.
Write:
- First line: what the document is, in one sentence (type and topic).
- Second line: its authors, venue, year and funding, as far as the document states them.
- If it cites, mentions or builds on any of the other documents in the collection (listed with the task), say which and how, as a bullet each. Its reference list is where to look.
- Then the points in it that bear on the task, as short bullets. Quote the document's own words in quotation marks where the exact wording matters, and say where (section or heading) when you can tell.
- Include what it says against or differently from the task's premise, not only what supports it.
If nothing in it bears on the task, write the first two lines and then exactly: ${NOTHING_RELEVANT}
At most ${EXTRACT_MAX_CHARS} characters. No preamble. ${LANGUAGE_RULE}`

const DRAFT_CARD_SYSTEM = `You summarise the user's own draft so that other documents can be read with it in mind: its topic, main claims, method, results, and its structure (section headings).
Short bullet points, at most ${DRAFT_CARD_MAX_CHARS} characters. No preamble. ${LANGUAGE_RULE}`

export interface Extract {
  text: string
  /** False when the document was read and had nothing on the task. */
  relevant: boolean
}

/** What one document says about the task, or its digest when no extract can be made. */
export async function extractOf(doc: CollectionDoc, others: string[], task: string, card: string, model: ModelTarget, abortSignal?: AbortSignal): Promise<Extract> {
  const brief = taskBrief(task, card, others)
  const size = mapInputChars(model, brief.length)
  const parts = Array.from({ length: Math.ceil(doc.text.length / size) }, (_, i) => doc.text.slice(i * size, (i + 1) * size))
  try {
    const outs: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const where = parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ''
      outs.push(await cachedCall(doc.fileId, model, brief, `Document: ${doc.filename}${where}\n\n${parts[i]}`, abortSignal))
    }
    return joinParts(outs)
  } catch (e) {
    if (abortSignal?.aborted) throw e
    console.error(`  [coverage] extract of ${doc.filename} failed, using its digest:`, e)
    return { text: await digestOf(doc, model, abortSignal), relevant: true }
  }
}

/** The task, the draft's card, and the other documents' titles — so each document is read for how it
 *  relates to them, which reading it alone would otherwise miss. */
const taskBrief = (task: string, card: string, others: string[]) =>
  `The task: ${task}`
  + (card ? `\n\nThe user's draft, which the task concerns:\n${card}` : '')
  + (others.length ? `\n\nThe other documents in the collection:\n${others.map(o => `- ${o}`).join('\n')}` : '')

/** One map call, from the cache when this document, model and brief were read before. */
async function cachedCall(fileId: string, model: ModelTarget, brief: string, prompt: string, abortSignal?: AbortSignal): Promise<string> {
  const key = modelKey(model)
  const hash = createHash('sha256').update(EXTRACT_SYSTEM).update('\0').update(brief).update('\0').update(prompt).digest('hex')
  const cached = sqlite.prepare('SELECT extract FROM resource_extracts WHERE file_id = ? AND model = ? AND key_hash = ?')
    .get(fileId, key, hash) as { extract: string } | null
  if (cached) return cached.extract
  const { text } = await generateText({
    model: languageModel(model),
    system: EXTRACT_SYSTEM,
    prompt: `${brief}\n\n${prompt}`,
    maxOutputTokens: outputCap(model, EXTRACT_MAX_TOKENS),
    abortSignal,
  })
  const extract = withoutThinking(text).slice(0, EXTRACT_MAX_CHARS * 2)
  if (!extract) throw new Error('empty extract')
  sqlite.prepare('INSERT OR REPLACE INTO resource_extracts(file_id, model, key_hash, extract, created_at) VALUES (?,?,?,?,?)')
    .run(fileId, key, hash, extract, Date.now())
  sqlite.prepare(`DELETE FROM resource_extracts WHERE file_id = ? AND rowid NOT IN (
    SELECT rowid FROM resource_extracts WHERE file_id = ? ORDER BY created_at DESC LIMIT ?)`).run(fileId, fileId, EXTRACTS_KEPT_PER_DOC)
  return extract
}

/** The parts' extracts as one; irrelevant only when no part had anything on the task. */
export function joinParts(outs: string[]): Extract {
  const relevant = outs.some(o => !o.includes(NOTHING_RELEVANT))
  const clean = (o: string) => o.replace(NOTHING_RELEVANT, 'Nothing on this task.').trim()
  if (outs.length === 1) return { text: clean(outs[0]), relevant }
  const kept = relevant ? outs.filter(o => !o.includes(NOTHING_RELEVANT)) : outs.slice(0, 1)
  return { text: kept.map(clean).join('\n'), relevant }
}

// Draft cards by model and draft text: made once per message, and again only for a new draft.
const draftCards = new Map<string, string>()
const DRAFT_CARDS_KEPT = 50

/** A short card of the user's attached draft, so each document is read with it in mind; empty when
 *  the card cannot be made, and the documents are then read for the task alone. */
export async function draftCard(draft: string, model: ModelTarget, abortSignal?: AbortSignal): Promise<string> {
  const key = createHash('sha256').update(modelKey(model)).update('\0').update(draft).digest('hex')
  const known = draftCards.get(key)
  if (known !== undefined) return known
  try {
    const { text } = await generateText({
      model: languageModel(model),
      system: DRAFT_CARD_SYSTEM,
      prompt: draft.slice(0, mapInputChars(model)),
      maxOutputTokens: outputCap(model, DRAFT_CARD_MAX_TOKENS),
      abortSignal,
    })
    const card = withoutThinking(text).slice(0, DRAFT_CARD_MAX_CHARS * 2)
    if (draftCards.size >= DRAFT_CARDS_KEPT) draftCards.delete(draftCards.keys().next().value!)
    draftCards.set(key, card)
    return card
  } catch (e) {
    if (abortSignal?.aborted) throw e
    console.error('  [coverage] draft card failed, reading for the task alone:', e)
    return ''
  }
}
