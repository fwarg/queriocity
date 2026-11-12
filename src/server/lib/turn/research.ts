import { runResearcher, maxStepsFor } from '../researcher.ts'
import { runWriter } from '../writer.ts'
import { drainResearcherStream } from '../researcher-stream.ts'
import { RESEARCHER_NOTES_CAP, EMPTY_ANSWER_MESSAGE, runSynthesisFallback } from '../answer.ts'
import { describeOutcome, type UrlOutcome } from '../fetch-url.ts'
import { ThinkExtractor } from '../think-extractor.ts'
import { rerankSearchResults } from '../reranker.ts'
import type { SearchResult, EngineError } from '../search/index.ts'
import { interleaveBatches } from '../search/fusion.ts'
import { prepareResearch, type ResearchInputs } from './prepare.ts'
import { AnswerStream } from './stream-answer.ts'
import { userQueryOf, additionalInstructions, withKeepalive, type TurnContext, type TurnResult, type TurnSink } from './context.ts'

// Snippet kept per stored source so citation hover previews still work after a reload —
// short enough that it costs little in the sources JSON column.
const STORED_SNIPPET_CHARS = 300

export const toStoredSource = (r: SearchResult) => ({
  title: r.title,
  url: r.url,
  content: r.content ? r.content.slice(0, STORED_SNIPPET_CHARS) : undefined,
})

/** Balanced and thorough modes: pre-search, the researcher's tool loop, and for thorough a writer pass. */
export async function runResearchTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  const t0 = Date.now()
  await sink.step({ kind: 'understand' })
  const inputs = await prepareResearch(ctx)
  if (inputs.fileSources.length > 0) await sink.emit({ type: 'file_sources', sources: inputs.fileSources })
  const progress = new ResearchProgress(sink, inputs)
  if (!inputs.initialResults?.length && inputs.engineErrors?.length) await progress.warnEngineErrors(inputs.engineErrors)

  const { content: answer, sources } = ctx.focusMode === 'thorough'
    ? await runThorough(ctx, sink, inputs, progress)
    : await runBalanced(ctx, sink, inputs, progress)

  // Last line of defence: nothing survived the main pass or the fallback. Name the failure in
  // the answer body — an empty `done` reads to the client as an unreachable server.
  let content = answer
  const emptyAnswer = !content.trim()
  if (emptyAnswer && !ctx.abortSignal.aborted) {
    console.error(`  [${ctx.focusMode}] empty answer after fallback — reporting failure to the client`)
    content = EMPTY_ANSWER_MESSAGE
    await sink.emit({ type: 'text', delta: content })
  }
  if (content.length < 50) console.log(`  [debug] short content: ${JSON.stringify(content)}`)
  console.log(`  [${ctx.focusMode}] done in ${Date.now() - t0}ms, ${content.length} chars`)
  // Never cache the failure notice — it would be replayed as the answer for every repeat of
  // this question until the entry expires.
  return { content, sources, fileSources: inputs.fileSources, cacheable: !emptyAnswer }
}

/** Progress narration shared by both research modes. */
class ResearchProgress {
  private readonly warnedEngines = new Set<string>()

  constructor(private readonly sink: TurnSink, private readonly inputs: ResearchInputs) {}

  /** Warn when a search came back empty *because* engines were blocked/suspended
   *  (rate-limit, CAPTCHA, access denied) — distinct from a query that simply matched
   *  nothing. Dedup by engine so the researcher's repeated searches don't spam the UI.
   *  Emitted as a persistent 'search_warning' (NOT the ephemeral status line, which is
   *  overwritten by later "Searching:" updates and cleared once answer text streams);
   *  the client folds it into the final footer so the user sees *why* results are missing. */
  warnEngineErrors = async (errors: EngineError[]) => {
    const fresh = errors.filter(e => !this.warnedEngines.has(e.engine))
    if (!fresh.length) return
    fresh.forEach(e => this.warnedEngines.add(e.engine))
    await this.sink.emit({ type: 'search_warning', engines: fresh.map(e => ({ engine: e.engine, reason: e.reason })) })
  }

  /** Second line for one fetch_url, and only when the page did not fit as-is: the first was
   *  emitted at tool-call time so the log moves while the fetch runs. */
  urlOutcome = (host: string, outcome: UrlOutcome) =>
    this.sink.step({ kind: 'read', hosts: [host], detail: describeOutcome(outcome) })

  searchStatus = (args: { queries?: string[]; query?: string }) => {
    const queries: string[] = args.queries ?? (args.query ? [args.query] : [])
    if (queries.length) this.sink.step({ kind: 'search', queries })
  }

  /** Pre-search runs before the researcher, so its steps are reported after the fact — the log
   *  still needs them, or the first thing the user sees is the researcher's second-round query
   *  with no sign of where the initial results came from. Initial snippets follow as thinking. */
  async preSearch() {
    const { processedUrls, initialQueries, initialResults, showThinking } = this.inputs
    if (processedUrls.length) {
      const reduced = processedUrls.filter(f => f.outcome).map(f => describeOutcome(f.outcome!))
      await this.sink.step({
        kind: 'read',
        hosts: processedUrls.map(f => new URL(f.url).hostname),
        detail: reduced.length ? reduced.join('; ') : undefined,
      })
    }
    if (initialQueries?.length) {
      await this.sink.step({ kind: 'search', queries: initialQueries })
      if (initialResults?.length) await this.sink.step({ kind: 'results', count: initialResults.length })
      if (showThinking) {
        await this.sink.emit({ type: 'thinking', delta: `🔍 Searching: ${initialQueries.map(q => `"${q}"`).join(', ')}\n` })
      }
    }
    if (showThinking && initialResults?.length) {
      const snippets = initialResults.slice(0, 3)
        .map(r => `  • ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 120)}…`)
        .join('\n')
      await this.sink.emit({ type: 'thinking', delta: snippets + '\n\n' })
    }
  }
}

/** Researcher options both modes share; the caller adds the model and its source handler. */
function researcherOptions(ctx: TurnContext, sink: TurnSink, inputs: ResearchInputs, progress: ResearchProgress) {
  return {
    messages: ctx.msgs, focusMode: ctx.focusMode as 'balanced' | 'thorough', userId: ctx.userId, abortSignal: ctx.abortSignal,
    initialQueries: inputs.initialQueries, initialResults: inputs.initialResults, prefetchedUrls: inputs.processedUrls,
    customPrompt: additionalInstructions(ctx, { examples: ctx.focusMode !== 'thorough' }), hasFiles: inputs.hasFiles, spaceId: ctx.spaceId, sessionId: ctx.sid,
    memoryBlock: inputs.memoryBlock, userMemoryEnabled: ctx.settings.userMemory === true,
    fetchSummarize: inputs.fetchSummarize, urlContextChars: inputs.urlContextChars, compressHistory: inputs.compressHistory,
    searchCategory: ctx.searchCategory, onEngineErrors: progress.warnEngineErrors, onUrlRead: progress.urlOutcome,
    searchBudget: inputs.searchBudget, requestApproval: sink.requestApproval, locked: ctx.locked, spaceWrites: ctx.spaceWrites, pinned: ctx.pinned,
    onContext: sink.context, maxStepsOverride: ctx.monitor?.maxStepsOverride,
  }
}

/** Thorough: the researcher gathers sources and notes silently, then the writer answers over them. */
async function runThorough(ctx: TurnContext, sink: TurnSink, inputs: ResearchInputs, progress: ResearchProgress) {
  await progress.preSearch()
  // One batch per search, kept apart so the cut in writerSources takes from every search rather than
  // only the first ones — see interleaveBatches.
  const batches: SearchResult[][] = [inputs.initialResults ?? []]
  // URLs the user pointed at or the model chose to read in full — kept out of the reranker's
  // prune below so a page that was explicitly fetched always reaches the writer.
  const fetchedUrls = new Set<string>()
  const researcherResult = await runResearcher({
    ...researcherOptions(ctx, sink, inputs, progress),
    model: inputs.researchModel,
    onSource: (s) => { batches.push([s]); fetchedUrls.add(s.url) },
  })
  let researcherNotes = ''
  // Unconditional: the extractor also drops leaked tool-call markup, which has to be stripped
  // whether or not the user is shown thinking. Displaying thinking is gated separately.
  await withKeepalive(sink, () => drainResearcherStream(researcherResult, {
    stream: sink.out, showThinking: inputs.showThinking, emitSearchStatus: progress.searchStatus, maxSteps: maxStepsFor('thorough'),
    extractor: new ThinkExtractor(),
    emitTextAsThinking: true,
    onText: (text) => { researcherNotes += text },
    onSources: (results) => { batches.push(results) },
  }))

  const finalSources = await writerSources(userQueryOf(ctx.msgs), batches, fetchedUrls)
  await sink.emit({ type: 'sources', sources: finalSources })

  await sink.step({ kind: 'write' })
  const writerResult = runWriter(ctx.models.chat, finalSources, ctx.msgs, researcherNotes.slice(0, RESEARCHER_NOTES_CAP), ctx.abortSignal, { customPrompt: additionalInstructions(ctx), memoryBlock: inputs.memoryBlock })
  const content = await new AnswerStream(sink, { showThinking: inputs.showThinking }).consume(writerResult.stream, { reasoning: true })
  if (!content) {
    console.error('  [writer] produced 0 chars — model may be in a bad state')
    await sink.emit({ type: 'status', text: 'Model returned empty response. Try again or restart the model server.' })
  }
  return { content, sources: finalSources.map(toStoredSource) }
}

/** Merges the searches' batches (deduped by URL), then reranks and prunes to rerank_top_n — or,
 *  without a reranker, just prunes, which is why the batches are interleaved rather than joined.
 *  Previously the full length was passed as topN, so the configured rerank_top_n was bypassed and
 *  every source reached the writer. Fetched pages skip the prune — they were read deliberately —
 *  and lead the list so their numbers are low. */
async function writerSources(query: string, batches: SearchResult[][], fetchedUrls: ReadonlySet<string>) {
  const deduped = interleaveBatches(batches)
  const fetched = deduped.filter(s => fetchedUrls.has(s.url))
  const reranked = await rerankSearchResults(query, deduped.filter(s => !fetchedUrls.has(s.url)))
  return [...fetched, ...reranked]
}

/** Balanced: the researcher's own text is the answer, streamed as it is written. */
async function runBalanced(ctx: TurnContext, sink: TurnSink, inputs: ResearchInputs, progress: ResearchProgress) {
  await progress.preSearch()
  const stored: unknown[] = []
  const { initialResults } = inputs
  if (initialResults?.length) {
    stored.push(...initialResults.map(toStoredSource))
    await sink.emit({ type: 'sources', sources: initialResults })
  }
  const found: SearchResult[] = []
  const onSources = async (results: SearchResult[]) => {
    found.push(...results)
    stored.push(...results.map(toStoredSource))
    await sink.emit({ type: 'sources', sources: results })
  }
  // A fetched page arrives as its own numbered result (prefetched before the stream, or via the
  // fetch_url tool mid-stream); surface it to the client the moment it lands so the [N] the
  // model then writes has a source to resolve against.
  const result = await runResearcher({
    ...researcherOptions(ctx, sink, inputs, progress),
    model: ctx.models.chat,
    onSource: (s) => onSources([s]),
  })
  const answer = new AnswerStream(sink)
  const finishReason = await withKeepalive(sink, () => drainResearcherStream(result, {
    stream: sink.out, showThinking: inputs.showThinking, emitSearchStatus: progress.searchStatus, maxSteps: maxStepsFor('balanced'),
    extractor: new ThinkExtractor(),
    onText: text => answer.text(text),
    onSources,
  }))
  await answer.end()

  // Fallback: synthesise an answer when the researcher ended without producing one.
  // Two ways that happens: finishReason=tool-calls (the model's last action was a tool call, so
  // any accumulated content is intermediate reasoning preamble, not a real response), or
  // finishReason=stop with nothing left after extraction — the withheld-tools final step wrote
  // its call out as <tool_call> prose, which ThinkExtractor drops. See think-extractor.ts.
  if (finishReason !== 'tool-calls' && answer.content.trim()) return { content: answer.content, sources: stored }
  console.warn(`  [${ctx.focusMode}] no answer (finish=${finishReason}, ${answer.content.length} chars) — running no-tool synthesis fallback`)
  await sink.step({ kind: 'write', detail: 'Synthesising answer…', detailKey: 'log.synthesise' })
  const fallback = runSynthesisFallback({
    model: ctx.models.chat,
    results: [...(initialResults ?? []), ...found],
    messages: ctx.msgs,
    memoryBlock: inputs.memoryBlock,
    abortSignal: ctx.abortSignal,
  })
  // Same extraction as the main pass: this call carries no tool schemas either, so a model
  // that emits <think> or <tool_call> markup would otherwise stream it as the answer.
  const content = await new AnswerStream(sink, { showThinking: inputs.showThinking }).consume(fallback.stream)
  return { content, sources: stored }
}
