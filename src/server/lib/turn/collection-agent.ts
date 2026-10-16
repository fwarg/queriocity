import { generateText, streamText, tool, stepCountIs, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { getAppSetting, sqlite } from '../db.ts'
import { languageModel, outputCap, RESEARCH_MAX_TOKENS, type ModelTarget } from '../llm.ts'
import { embedText } from '../embeddings.ts'
import { userMemoryBlockIfEnabled, joinMemoryBlocks } from '../memory.ts'
import { searchFile } from '../files/uploads-search.ts'
import { withoutConfidential } from '../files/confidential.ts'
import { documentParts, outlineOf, partOfChunk } from '../files/collection-parts.ts'
import { trimMessages, CONTEXT_RESERVE_FRACTION } from '../trim-messages.ts'
import { thinkingFor } from './prepare.ts'
import { AnswerStream } from './stream-answer.ts'
import { userQueryOf, withKeepalive, type TurnContext, type TurnResult, type TurnSink } from './context.ts'

/** Explore mode: an agent reads the picked collections for a targeted question — lists the
 *  documents, searches them, reads the parts that matter, and notes what it finds — then the answer
 *  is written from its notes. Two phases: the exploration is a tool loop whose prompt stays small
 *  (part texts already read are dropped; the notes are restated every step), and the answer is one
 *  streamed call over the notes. An exploration that ends early is answered from what it noted. */

export const DEFAULT_EXPLORE_MAX_STEPS = '20'
/** Read part texts kept in full; older ones are replaced, their content being in the notes. */
const PARTS_KEPT = 2
/** A search returns each document's best hits, so one document full of matches cannot crowd out
 *  another with a few: up to this many per document, best first across documents… */
const HITS_PER_DOC = 2
/** …and this many in all, scaled with the collection. */
const MIN_HITS = 8
const MAX_HITS = 30
/** Hits when searching one named document. */
const DOC_HITS = 6
const EXCERPT_CHARS = 300

const EXPLORE_SYSTEM = `You explore a collection of documents to answer the user's message, which may come with an attached document (for instance their own draft).
Use the tools: list_documents first, then outline, search_collection and read_part to find and read what matters, and note to record every finding you will need — with the document label, part and a short quote. Only your notes reach the answer, so note as you go.
Be targeted: read the parts that bear on the message, not everything. A search across all documents shows each document's best matches; a document whose best matches are clearly unrelated can be ruled out. Search a document on its own (the doc field), or outline it, only if it did not appear in the results or its matches are ambiguous — for instance when the topic may be worded differently there.
When your notes cover the message, stop calling tools and reply "done".`

const ANSWER_SYSTEM = `Answer the user's message from the notes below, which were taken while exploring the documents the user selected. Do not invent what the notes do not say; say so when they do not cover something.
Cite a document inline by its label (e.g. [C1]); do not invent any other citation format. Use ## headings, lists and tables where they help. Always respond in the same language the user used.`

interface Doc { label: string; fileId: string; filename: string; summary: string | null }
interface Note { doc: string; part?: number; finding: string; quote?: string }

export function runCollectionAgent(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  return withKeepalive(sink, () => exploreAndAnswer(ctx, sink))
}

async function exploreAndAnswer(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  const t0 = Date.now()
  const model = thinkingFor(ctx).researchModel
  const docs = collectionIndex(ctx.collections, ctx.locked)
  const fileSources = docs.map(d => ({ title: `[${d.label}] ${d.filename}`, url: `file:${d.fileId}`, label: d.label }))
  if (fileSources.length) await sink.emit({ type: 'file_sources', sources: fileSources })
  const notes: Note[] = []
  const maxSteps = Number(await getAppSetting('collection_explore_max_steps', DEFAULT_EXPLORE_MAX_STEPS))
  const { steps, endedEarly } = await explore(ctx, sink, model, docs, notes, maxSteps)
  await sink.emit({ type: 'exploration', steps, notes: notes.length, endedEarly })
  const content = await answerFromNotes(ctx, sink, model, docs, notes)
  console.log(`  [explore] ${steps} steps, ${notes.length} notes${endedEarly ? ', ended early' : ''}, ${Date.now() - t0}ms, ${content.length} chars`)
  return { content, sources: [], fileSources, cacheable: false, answeredBy: model }
}

/** The documents in the collections, labelled C1… by filename, without their text. */
export function collectionIndex(collectionIds: string[], includeConfidential: boolean): Doc[] {
  if (!collectionIds.length) return []
  const rows = sqlite.prepare(`
    SELECT DISTINCT f.id, f.filename, f.summary FROM space_files sf
    JOIN uploaded_files f ON f.id = sf.file_id
    WHERE sf.space_id IN (${collectionIds.map(() => '?').join(',')}) ${withoutConfidential('f.id', includeConfidential)}
    ORDER BY f.filename, f.id
  `).all(...collectionIds) as Array<{ id: string; filename: string; summary: string | null }>
  return rows.map((r, i) => ({ label: `C${i + 1}`, fileId: r.id, filename: r.filename, summary: r.summary }))
}

/** The tool loop. Ends when the model stops calling tools, at `maxSteps`, or on an error — the last
 *  two count as ending early, and the answer is then written from whatever was noted. */
async function explore(ctx: TurnContext, sink: TurnSink, model: ModelTarget, docs: Doc[], notes: Note[], maxSteps: number) {
  const history = trimMessages(ctx.msgs, Math.floor(model.contextTokens * CONTEXT_RESERVE_FRACTION), EXPLORE_SYSTEM, ctx.pinned)
  try {
    const result = await generateText({
      model: languageModel(model),
      system: EXPLORE_SYSTEM,
      messages: history.messages,
      tools: exploreTools(ctx, sink, docs, notes),
      stopWhen: stepCountIs(maxSteps),
      abortSignal: ctx.abortSignal,
      prepareStep: ({ messages }) => ({ instructions: EXPLORE_SYSTEM + notesBlock(notes), messages: compactReads(messages) }),
    })
    const last = result.steps.at(-1)
    return { steps: result.steps.length, endedEarly: result.steps.length >= maxSteps && !!last?.toolCalls.length }
  } catch (e) {
    if (ctx.abortSignal.aborted) throw e
    console.error('  [explore] exploration failed, answering from the notes so far:', e)
    return { steps: 0, endedEarly: true }
  }
}

function exploreTools(ctx: TurnContext, sink: TurnSink, docs: Doc[], notes: Note[]): ToolSet {
  const byLabel = (label: string) => docs.find(d => d.label.toLowerCase() === label.trim().toLowerCase())
  const docInput = z.string().describe('The document label, e.g. C2')
  return {
    list_documents: tool({
      description: 'List every document in the collection: label, title, one-line summary and number of parts.',
      inputSchema: z.object({}),
      execute: async () => docs.map(d => `[${d.label}] ${d.filename} — ${d.summary ?? 'no summary'} — ${documentParts(d.fileId).length} parts`).join('\n'),
    }),
    outline: tool({
      description: 'What each part of one document covers, one line per part.',
      inputSchema: z.object({ doc: docInput }),
      execute: async ({ doc }) => {
        const d = byLabel(doc)
        if (!d) return `No document ${doc}.`
        await sink.step({ kind: 'outline', detail: d.label })
        const parts = documentParts(d.fileId)
        const lines = await outlineOf(d.fileId, parts, ctx.abortSignal)
        return lines.map((l, i) => `Part ${i + 1}: ${l}`).join('\n')
      },
    }),
    search_collection: tool({
      description: 'Search the documents for passages about something — every document, or one with `doc` — returning where they are (document and part) with an excerpt. Across all documents it returns each document\'s best matches, nearest first.',
      inputSchema: z.object({ query: z.string(), doc: docInput.optional() }),
      execute: async ({ query, doc }) => {
        const one = doc ? byLabel(doc) : undefined
        if (doc && !one) return `No document ${doc}.`
        await sink.step({ kind: 'search', queries: [one ? `${query} (${one.label})` : query] })
        const hits = searchSpread(one ? [one] : docs, await embedText(query), ctx.locked)
        return hits.map(({ doc: d, row }) => `[${d.label}] part ${partOfChunk(Number(row.chunkId.split(':').pop()))}: ${row.content.slice(0, EXCERPT_CHARS)}`)
          .join('\n\n') || 'Nothing found.'
      },
    }),
    read_part: tool({
      description: 'Read one part of a document in full.',
      inputSchema: z.object({ doc: docInput, part: z.number().int().min(1) }),
      execute: async ({ doc, part }) => {
        const d = byLabel(doc)
        const parts = d ? documentParts(d.fileId) : []
        if (!d || !parts[part - 1]) return `No part ${part} in ${doc}${d ? ` (it has ${parts.length})` : ''}.`
        await sink.step({ kind: 'readPart', detail: `${d.label} · ${part}/${parts.length}` })
        return parts[part - 1].text
      },
    }),
    note: tool({
      description: 'Record a finding for the answer, with where it is and a short quote.',
      inputSchema: z.object({ doc: docInput, part: z.number().int().optional(), finding: z.string(), quote: z.string().optional() }),
      execute: async (n) => {
        notes.push(n)
        await sink.step({ kind: 'note', count: notes.length, update: notes.length > 1 })
        return `Noted (${notes.length}).`
      },
    }),
  }
}

/** The nearest chunks of each document, best hits first across documents, then second-best: every
 *  document gets its best match in before any gets a second. One document searched gets DOC_HITS. */
export function searchSpread(docs: Doc[], embedding: number[], includeConfidential: boolean) {
  const perDoc = docs.map(doc => searchFile(doc.fileId, embedding, docs.length === 1 ? DOC_HITS : HITS_PER_DOC, includeConfidential).map(row => ({ doc, row })))
  const total = docs.length === 1 ? DOC_HITS : Math.min(MAX_HITS, Math.max(MIN_HITS, HITS_PER_DOC * docs.length))
  const ranks = Math.max(0, ...perDoc.map(h => h.length))
  return Array.from({ length: ranks }, (_, rank) => perDoc.flatMap(h => h[rank] ? [h[rank]] : []).sort((a, b) => a.row.distance - b.row.distance))
    .flat().slice(0, total)
}

/** The notes restated for the model, so they survive the part texts being dropped. */
function notesBlock(notes: Note[]): string {
  if (!notes.length) return '\n\n## Your notes so far\n(none yet)'
  return `\n\n## Your notes so far (${notes.length})\n` + notes.map(formatNote).join('\n')
}

const formatNote = (n: Note) => `- [${n.doc.toUpperCase()}${n.part ? ` part ${n.part}` : ''}] ${n.finding}${n.quote ? ` — "${n.quote}"` : ''}`

/** The messages with all but the latest read_part results replaced: what mattered is in the notes. */
export function compactReads(messages: ModelMessage[]): ModelMessage[] {
  const readIds = messages.flatMap(m => m.role === 'tool'
    ? m.content.flatMap(p => p.type === 'tool-result' && p.toolName === 'read_part' ? [p.toolCallId] : [])
    : [])
  const dropped = new Set(readIds.slice(0, Math.max(0, readIds.length - PARTS_KEPT)))
  if (!dropped.size) return messages
  return messages.map(m => m.role !== 'tool' ? m : {
    ...m,
    content: m.content.map(p => p.type === 'tool-result' && dropped.has(p.toolCallId)
      ? { ...p, output: { type: 'text' as const, value: '[Part read earlier; what mattered is in your notes.]' } }
      : p),
  })
}

/** The answer, streamed, from the notes; "writing" starts with its first output. */
async function answerFromNotes(ctx: TurnContext, sink: TurnSink, model: ModelTarget, docs: Doc[], notes: Note[]): Promise<string> {
  const query = userQueryOf(ctx.msgs)
  const documents = '## The documents\n' + docs.map(d => `- [${d.label}] ${d.filename}`).join('\n')
  const noted = notes.length ? `## Notes from exploring them\n${notes.map(formatNote).join('\n')}` : '## Notes from exploring them\n(nothing was noted)'
  const system = joinMemoryBlocks(
    ANSWER_SYSTEM + (ctx.customPrompt ? `\n\nAdditional instructions:\n${ctx.customPrompt}` : ''),
    await userMemoryBlockIfEnabled(ctx.userId, ctx.settings, query),
    documents,
    noted,
  )
  await sink.step({ kind: 'readNotes', count: notes.length })
  const history = trimMessages(ctx.msgs, Math.floor(model.contextTokens * CONTEXT_RESERVE_FRACTION), system, ctx.pinned)
  await sink.context(history.report)
  const result = streamText({ model: languageModel(model), abortSignal: ctx.abortSignal, system, messages: history.messages, maxOutputTokens: outputCap(model, RESEARCH_MAX_TOKENS) })
  let started = false
  const stream = (async function* () {
    for await (const part of result.stream) {
      if (!started && (part.type === 'text-delta' || part.type === 'reasoning-delta')) { started = true; await sink.step({ kind: 'write' }) }
      yield part
    }
  })()
  return new AnswerStream(sink, { citations: false, showThinking: thinkingFor(ctx).showThinking }).consume(stream, { reasoning: true })
}
