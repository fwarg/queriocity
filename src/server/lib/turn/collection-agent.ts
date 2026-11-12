import { generateText, streamText, tool, stepCountIs, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { getNumberSetting } from '../db.ts'
import { languageModel, outputCap, researchMaxTokens, type ModelTarget } from '../llm.ts'
import { embedText } from '../embeddings.ts'
import { userMemoryBlockIfEnabled, joinMemoryBlocks } from '../memory/index.ts'
import { splitAttachments } from '../../../shared/context.ts'
import { asDocumentReferences } from '../../../shared/citations.ts'
import { scopedFiles, type DocumentScope } from '../files/collection-coverage.ts'
import { documentParts, outlineOf, partCount } from '../files/collection-parts.ts'
import {
  firstLook, searchSpread, relevantHits, seeHit, formatHit, seenBlock, readsBlock, evidenceBlock, formatNote, READ_MAX_CHARS, READ_MAX_SHARE,
  type Doc, type Note, type Gathered,
} from './collection-evidence.ts'
import { trimMessages, meterBudgetChars, CONTEXT_RESERVE_FRACTION } from '../trim-messages.ts'
import { thinkingFor, spaceMemoryOnly } from './prepare.ts'
import { AnswerStream } from './stream-answer.ts'
import { startWeb, webSearchTool, webBlock, EXPLORE_WEB_INSTRUCTION, type WebSearching } from './collection-web.ts'
import { saveNoteTool, savedNotesBlock, saveFindings, EXPLORE_NOTES_INSTRUCTION, NOTES_WEB_INSTRUCTION, type SavedNote } from './collection-notes.ts'
import { toStoredSource } from './research.ts'
import { userQueryOf, withInstructions, withKeepalive, documentSet, type TurnContext, type TurnResult, type TurnSink } from './context.ts'

/** Explore mode: an agent reads the picked collections for a targeted question — lists the
 *  documents, searches them, reads the parts that matter, and notes what it finds — then the answer
 *  is written from its notes. Two phases: the exploration is a tool loop whose prompt stays small
 *  (part texts already read are dropped; the notes are restated every step), and the answer is one
 *  streamed call over the notes. An exploration that ends early is answered from what it noted. */

export const DEFAULT_EXPLORE_MAX_STEPS = 20
/** The admin setting's ceiling, and the most a collection's size can raise the limit to. */
export const MAX_EXPLORE_STEPS = 100
/** Read part texts kept in full; older ones are replaced, their content being in the notes. */
const PARTS_KEPT = 2
/** The exploring loop: tool calls, then a short "done". Only the notes it records reach the answer. */
const EXPLORE_SYSTEM = `You explore a collection of documents to answer the user's message, which may come with an attached document (for instance their own draft).
A first look — each document's passages nearest the message — is given below; use it to decide which documents to look into. A document it shows nothing close for can be ruled out without searching it.
Use the tools: list_documents, outline, search_collection and read_part to find and read what matters, and note to record every finding you will need — with the document label, part and a short quote. Only your notes reach the answer, so note as you go.
Be targeted: read the parts that bear on the message, not everything. A search across all documents shows each document's best matches; a document whose best matches are clearly unrelated can be ruled out. Search a document on its own (the doc field), or outline it, only if it did not appear in the results or its matches are ambiguous — for instance when the topic may be worded differently there.
To summarise what a document says about something, read the two or three parts that match it most often in the search results, not just one.
When your notes cover the message, stop calling tools and reply "done".`

/** The answer after exploring: Markdown streamed to the user, citing documents by label ([C1]). */
const ANSWER_SYSTEM = `Answer the user's message from what was gathered while exploring the documents the user selected: the notes, the passages found (excerpts), and the parts read in full, all below. Use everything relevant there; be thorough rather than brief when the material allows. Do not invent what it does not say; say so when it does not cover something.
Cite a document inline by its label (e.g. [C1]); do not invent any other citation format. Use ## headings, lists and tables where they help. Always respond in the same language the user used.`

/** A part number, also when a model sends it as text ("5"). */
const partNumber = z.coerce.number().int().min(1)

/** Shorter closing text is a sign-off ("done"), not findings. */
const CLOSING_MIN_CHARS = 40
/** Sent once when, saving notes, the model stops before the step limit with documents unread (explore). */
const continueNudge = (unread: string[]) => `You have not read any part of ${unread.join(', ')} yet. If the message calls for them, continue exploring: call note for each part you have read, then outline and read those documents, saving notes as you go. Otherwise reply "done".`
const NOTE_NOW = `\n\nYou have just read: call note now, once for each part you just read, with what in it bears on the message and a short quote. If nothing in a part does, note that. Do not reply with text yet — that ends the exploration.`

export function runCollectionAgent(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  return withKeepalive(sink, () => exploreAndAnswer(ctx, sink))
}

async function exploreAndAnswer(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  const t0 = Date.now()
  const model = thinkingFor(ctx).researchModel
  const docs = collectionIndex(documentSet(ctx), ctx.locked)
  const fileSources = docs.map(d => ({ title: `[${d.label}] ${d.filename}`, url: `file:${d.fileId}`, label: d.label }))
  if (fileSources.length) await sink.emit({ type: 'file_sources', sources: fileSources })
  const gathered: Gathered = { notes: [], seen: new Map(), reads: new Map(), queries: [], locked: ctx.locked }
  const maxSteps = exploreSteps(await getNumberSetting('collection_explore_max_steps', DEFAULT_EXPLORE_MAX_STEPS), docs, ctx.exploreNotes === true)
  // Saving notes covers every document, so nothing is ruled out by closeness to the message.
  const overview = await firstLook(splitAttachments(userQueryOf(ctx.msgs)).text, docs, gathered, { search: !ctx.exploreNotes })
  const web = await startWeb(ctx)
  const saved: SavedNote[] | undefined = ctx.exploreNotes ? [] : undefined
  const { steps, endedEarly } = await explore(ctx, sink, model, docs, gathered, overview, maxSteps, web, saved)
  // Also after the step limit: what was read last was noted but not yet saved.
  if (saved && (!saved.length || endedEarly)) await saveFindings(ctx, sink, model, docs, saved, await findings(gathered, model), web)
  const { notes } = gathered
  await sink.emit({ type: 'exploration', steps, notes: notes.length, endedEarly })
  if (web?.results.length) await sink.emit({ type: 'sources', sources: web.results })
  if (saved?.length) await sink.emit({ type: 'saved_notes', notes: saved.map(({ id, title }) => ({ id, title })) })
  const content = await answerFromNotes(ctx, sink, model, docs, gathered, web, saved)
  console.log(`  [explore] ${steps} steps, ${notes.length} notes, ${gathered.seen.size} passages seen${web ? `, ${web.results.length} web results` : ''}${saved ? `, ${saved.length} saved to the library` : ''}${endedEarly ? ', ended early' : ''}, ${Date.now() - t0}ms, ${content.length} chars`)
  return { content, sources: (web?.results ?? []).map(toStoredSource), fileSources, cacheable: false, answeredBy: model, savedNoteIds: saved?.map(s => s.id) }
}

/** The step limit. Saving notes means writing as well as reading: twice the setting, and at least
 *  a step per part plus two per document (outline, a last note) and room to save, up to the ceiling. */
export function exploreSteps(setting: number, docs: Doc[], savingNotes: boolean): number {
  if (!savingNotes) return setting
  const parts = docs.reduce((n, d) => n + partCount(d.fileId), 0)
  return Math.max(setting * 2, Math.min(MAX_EXPLORE_STEPS, parts + 2 * docs.length + SAVING_ROOM))
}
/** Steps for saving, beyond the reading. */
const SAVING_ROOM = 10

/** The documents in scope, labelled C1… by filename, without their text. */
export function collectionIndex(scope: string[] | DocumentScope, includeConfidential: boolean): Doc[] {
  return scopedFiles(scope, includeConfidential).map((r, i) => ({ label: `C${i + 1}`, fileId: r.id, filename: r.filename, summary: r.summary }))
}

/** The tool loop. Ends when the model stops calling tools, at `maxSteps`, or on an error — the last
 *  two count as ending early, and the answer is then written from whatever was gathered. */
async function explore(ctx: TurnContext, sink: TurnSink, model: ModelTarget, docs: Doc[], gathered: Gathered, overview: string, maxSteps: number, web?: WebSearching, saved?: SavedNote[]) {
  const system = EXPLORE_SYSTEM + (web ? EXPLORE_WEB_INSTRUCTION : '') + (saved ? EXPLORE_NOTES_INSTRUCTION : '') + (saved && web ? NOTES_WEB_INSTRUCTION : '') + overview
  const tools: ToolSet = {
    ...exploreTools(ctx, sink, docs, gathered),
    ...(web && { web_search: webSearchTool(ctx, sink, web, gathered) }),
    ...(saved && { save_note: saveNoteTool(ctx, sink, model, docs, saved, web) }),
  }
  const history = trimMessages(ctx.msgs, Math.floor(model.contextTokens * CONTEXT_RESERVE_FRACTION), system, ctx.pinned)
  let step = 0
  let readsBefore = 0
  const run = (messages: ModelMessage[], steps: number) => generateText({
    model: languageModel(model),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(steps),
    abortSignal: ctx.abortSignal,
    prepareStep: ({ messages }) => {
      // After a part is read, the next step offers only `note` and asks for it: a model that skips
      // its bookkeeping is prompted, and still decides what the note says. Offered, not enforced —
      // a local server may not honour a forced tool, and the SDK fails the whole run when one is
      // ignored; a model that answers instead simply ends the exploration.
      // A new part read since the last step — not a failed or repeated read.
      const justRead = gathered.reads.size > readsBefore
      readsBefore = gathered.reads.size
      return {
        instructions: system + notesBlock(gathered.notes) + (justRead ? NOTE_NOW : ''),
        messages: compactReads(messages),
        ...(justRead && { activeTools: ['note'] }),
      }
    },
    onStepFinish: s => logStep(++step, s),
  })
  try {
    let result = await run(history.messages, maxSteps)
    let steps = result.steps.length
    const closings = [result.text.trim()]
    // Saving notes, a model may stop with documents unread — DeepSeek did, at the note step, with
    // text or with "done". Told once which are unread; a second stop is taken as its answer.
    const unread = docs.filter(d => ![...gathered.reads.values()].some(r => r.doc.label === d.label)).map(d => d.label)
    if (saved && unread.length && steps < maxSteps && !result.steps.at(-1)?.toolCalls.length) {
      console.log(`  [explore] stopped with ${unread.join(', ')} unread; told to continue`)
      result = await run([...history.messages, ...result.response.messages, { role: 'user', content: continueNudge(unread) }], maxSteps - steps)
      steps += result.steps.length
      closings.push(result.text.trim())
    }
    // A model may end by writing its findings rather than "done": kept, so they reach the answer.
    const closing = closings.filter(c => c.length > CLOSING_MIN_CHARS).join('\n\n')
    if (closing) gathered.closing = closing
    return { steps, endedEarly: steps >= maxSteps && !!result.steps.at(-1)?.toolCalls.length }
  } catch (e) {
    if (ctx.abortSignal.aborted) throw e
    console.error('  [explore] exploration failed, answering from the notes so far:', e)
    return { steps: step, endedEarly: true }
  }
}

/** One line per step in the server log: the tools called with their input, and any that failed. */
function logStep(n: number, step: { toolCalls: Array<{ toolName: string; input: unknown }>; content: Array<{ type: string; toolName?: string; error?: unknown }> }) {
  const calls = step.toolCalls.map(c => `${c.toolName}(${JSON.stringify(c.input).slice(0, 100)})`).join(', ') || 'no tool call'
  const errors = step.content.filter(p => p.type === 'tool-error').map(p => `${p.toolName}: ${String(p.error instanceof Error ? p.error.message : p.error).slice(0, 120)}`)
  console.log(`  [explore] step ${n}: ${calls}${errors.length ? ` — failed: ${errors.join('; ')}` : ''}`)
}

function exploreTools(ctx: TurnContext, sink: TurnSink, docs: Doc[], gathered: Gathered): ToolSet {
  const { notes } = gathered
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
        // The model sees every hit it asked for and judges them itself — a floor cut thin but real
        // matches (one document's whole treatment of a topic scored 0.05). Only those above it are
        // passed to the answer unasked; anything the model finds relevant it notes.
        gathered.queries.push(query)
        const found = searchSpread(one ? [one] : docs, await embedText(query, 'query'), ctx.locked)
        const { kept } = await relevantHits(query, found, gathered.floor)
        for (const h of kept) seeHit(h, gathered)
        return found.map(formatHit).join('\n\n') || 'Nothing found.'
      },
    }),
    read_part: tool({
      description: 'Read one part of a document in full.',
      inputSchema: z.object({ doc: docInput, part: partNumber }),
      execute: async ({ doc, part }) => {
        const d = byLabel(doc)
        const parts = d ? documentParts(d.fileId) : []
        if (!d || !parts[part - 1]) return `No part ${part} in ${doc}${d ? ` (it has ${parts.length})` : ''}.`
        if (gathered.reads.has(`${d.label}:${part}`)) return `Already read ${d.label} part ${part}: what mattered is in your notes. Read another part, or another document.`
        await sink.step({ kind: 'readPart', detail: `${d.label} · ${part}/${parts.length}` })
        gathered.reads.set(`${d.label}:${part}`, { doc: d, part, text: parts[part - 1].text })
        return parts[part - 1].text
      },
    }),
    note: tool({
      description: 'Record a finding for the answer, with where it is and a short quote.',
      inputSchema: z.object({ doc: docInput, part: partNumber.optional(), finding: z.string(), quote: z.string().optional() }),
      execute: async (n) => {
        notes.push(n)
        await sink.step({ kind: 'note', count: notes.length, update: notes.length > 1 })
        return `Noted (${notes.length}).`
      },
    }),
  }
}

/** What exploring found — the notes and the parts read — for the pass that saves it. */
async function findings(gathered: Gathered, model: ModelTarget): Promise<string> {
  const reads = await readsBlock(gathered, Math.min(READ_MAX_CHARS, Math.floor(meterBudgetChars(model.contextTokens) * READ_MAX_SHARE)))
  const noted = gathered.notes.length ? `## Notes from exploring\n${gathered.notes.map(formatNote).join('\n')}` : ''
  return joinMemoryBlocks(noted, closingBlock(gathered), reads.block)
}

/** What the model wrote when it stopped exploring, if it wrote findings rather than "done". */
const closingBlock = (gathered: Gathered) => gathered.closing ? `## What the explorer wrote when it stopped\n${gathered.closing}` : ''

/** The notes restated for the model, so they survive the part texts being dropped. */
function notesBlock(notes: Note[]): string {
  if (!notes.length) return '\n\n## Your notes so far\n(none yet)'
  return `\n\n## Your notes so far (${notes.length})\n` + notes.map(formatNote).join('\n')
}

/** The messages with all but the latest read_part results replaced: what mattered is in the notes.
 *  The latest step's reads are always kept, however many ran at once — they are not noted yet. */
export function compactReads(messages: ModelMessage[]): ModelMessage[] {
  const readsIn = (m: ModelMessage) => m.role === 'tool'
    ? m.content.flatMap(p => p.type === 'tool-result' && p.toolName === 'read_part' ? [p.toolCallId] : [])
    : []
  const readIds = messages.flatMap(readsIn)
  const latest = readsIn(messages.findLast(m => m.role === 'tool') ?? { role: 'user', content: '' })
  const dropped = new Set(readIds.slice(0, Math.max(0, readIds.length - Math.max(PARTS_KEPT, latest.length))))
  if (!dropped.size) return messages
  return messages.map(m => m.role !== 'tool' ? m : {
    ...m,
    content: m.content.map(p => p.type === 'tool-result' && dropped.has(p.toolCallId)
      ? { ...p, output: { type: 'text' as const, value: '[Part read earlier; what mattered is in your notes.]' } }
      : p),
  })
}

/** The answer, streamed, from the notes; "writing" starts with its first output. */
async function answerFromNotes(ctx: TurnContext, sink: TurnSink, model: ModelTarget, docs: Doc[], gathered: Gathered, web?: WebSearching, saved?: SavedNote[]): Promise<string> {
  const { notes } = gathered
  const query = userQueryOf(ctx.msgs)
  const reads = await readsBlock(gathered, Math.min(READ_MAX_CHARS, Math.floor(meterBudgetChars(model.contextTokens) * READ_MAX_SHARE)))
  const documents = '## The documents\n' + docs.map(d => `- [${d.label}] ${d.filename}`).join('\n')
  const noted = notes.length ? `## Notes from exploring them\n${notes.map(formatNote).join('\n')}` : '## Notes from exploring them\n(nothing was noted)'
  const system = joinMemoryBlocks(
    ANSWER_SYSTEM + withInstructions(ctx),
    await userMemoryBlockIfEnabled(ctx.userId, ctx.settings, query),
    await spaceMemoryOnly(ctx, query),
    // The documents' own [7]-style references, rewritten so they cannot pass for the web's [1]….
    asDocumentReferences(joinMemoryBlocks(documents, noted, closingBlock(gathered), seenBlock(gathered.seen), reads.block, evidenceBlock(gathered, reads.included))),
    webBlock(web),
    savedNotesBlock(saved, docs),
  )
  await sink.step({ kind: 'readNotes', count: notes.length })
  const history = trimMessages(ctx.msgs, Math.floor(model.contextTokens * CONTEXT_RESERVE_FRACTION), system, ctx.pinned)
  await sink.context(history.report)
  const result = streamText({ model: languageModel(model), abortSignal: ctx.abortSignal, system, messages: history.messages, maxOutputTokens: outputCap(model, researchMaxTokens()) })
  let started = false
  const stream = (async function* () {
    for await (const part of result.stream) {
      if (!started && (part.type === 'text-delta' || part.type === 'reasoning-delta')) { started = true; await sink.step({ kind: 'write' }) }
      yield part
    }
  })()
  // Web results are cited [1]…, which the normaliser tidies; the documents' [C1] labels need none.
  return new AnswerStream(sink, { citations: !!web?.results.length, showThinking: thinkingFor(ctx).showThinking }).consume(stream, { reasoning: true })
}
