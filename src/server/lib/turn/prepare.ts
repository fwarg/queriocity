import { db, uploadedFiles, getAppSetting } from '../db.ts'
import { eq, sql } from 'drizzle-orm'
import { reformulateLLM } from '../reformulate.ts'
import { webSearch, webSearchMulti, newSearchBudget, type SearchResult, type EngineError, type SearchBudget } from '../search/index.ts'
import { fetchUrlAllPages, processUrlsForContext, DEFAULT_MAX_URL_CONTEXT_CHARS, type ProcessedUrl } from '../fetch-url.ts'
import { DEFAULT_MEMORY_TOKEN_BUDGET } from '../llm.ts'
import { rerankSearchResults } from '../reranker.ts'
import { notesRagBudget } from '../rag-settings.ts'
import { buildMemoryBlock, buildChatFileBlock, buildCollectionBlock, buildNotesBlock, userMemoryBlockIfEnabled, joinMemoryBlocks } from '../memory.ts'
import { contextCharBudget } from '../trim-messages.ts'
import { hasAttachment } from '../../../shared/context.ts'
import { userQueryOf, additionalInstructions, type TurnContext, type TurnMessage } from './context.ts'

/** Token budget for the collections picked this request, or 0 when none are.
 *
 *  Reads `space_rag_budget` rather than adding a setting of its own: it is the same question — how
 *  many tokens of retrieved document may enter a prompt — and one knob is easier to reason about
 *  than two. Read only when collections are actually selected, so the usual request is unchanged. */
export const collectionRagBudget = async (collections: string[]): Promise<number> =>
  collections.length ? Number(await getAppSetting('space_rag_budget', '500')) : 0

/** Maps the client's category chips onto SearXNG category names. */
export function toSearxngCategories(cats?: string[]): string | undefined {
  if (!cats?.length) return undefined
  const map: Record<string, string> = { discussions: 'social media', tech: 'it' }
  return cats.map(c => map[c] ?? c).join(',')
}

export type ResearchInputs = Awaited<ReturnType<typeof prepareResearch>>

/** Everything balanced and thorough research needs before the researcher starts: pre-search,
 *  memory and document context, prefetched URLs, and the settings that shape the run. */
export async function prepareResearch(ctx: TurnContext) {
  const [fetchMaxPages, urlContextChars, fetchSummarize, compressHistory] = await Promise.all([
    getAppSetting('fetch_max_pages', '8').then(Number),
    getAppSetting('fetch_max_url_context_chars', String(DEFAULT_MAX_URL_CONTEXT_CHARS)).then(Number),
    getAppSetting('fetch_summarize_overflow', 'false').then(v => v === 'true'),
    getAppSetting('compress_history_overflow', 'false').then(v => v === 'true'),
  ])
  // Shared per-request allowance for paid keyed-API fallback searches (pre-search + researcher).
  const searchBudget = await newSearchBudget(ctx.monitor ? 'monitor' : ctx.focusMode === 'thorough' ? 'thorough' : 'balanced')
  const gathered = await gatherContext(ctx, searchBudget, fetchMaxPages)

  const { showThinking, researchModel } = thinkingFor(ctx)
  // URL text goes into the researcher's context, so it is budgeted against the model that runs it.
  const processedUrls = gathered.prefetchedUrls.length > 0
    ? await processUrlsForContext(gathered.prefetchedUrls, urlBudgetChars(ctx, researchModel.contextTokens, gathered.memoryBlock), fetchSummarize, urlContextChars)
    : gathered.prefetchedUrls
  return { ...gathered, processedUrls, showThinking, researchModel, searchBudget, urlContextChars, fetchSummarize, compressHistory }
}

/** Whether the mode shows its thinking, and the model that researches: the thinking model in
 *  thorough mode when the user has it on, else the chat model. */
/** The space's memory without its resource excerpts, for turns that read the resources another way
 *  (Whole collection, Explore); empty outside a space. */
export async function spaceMemoryOnly(ctx: TurnContext, query: string): Promise<string> {
  if (!ctx.spaceId) return ''
  const budget = Number(await getAppSetting('memory_token_budget', DEFAULT_MEMORY_TOKEN_BUDGET))
  return (await buildMemoryBlock(ctx.spaceId, budget, 0, query, undefined, ctx.includeMemoryIds, ctx.locked)).block
}

export function thinkingFor(ctx: TurnContext) {
  const showThinkingSettings = (ctx.settings.showThinking ?? { balanced: false, thorough: false }) as { balanced: boolean; thorough: boolean }
  const showThinking = ctx.focusMode === 'balanced' ? showThinkingSettings.balanced
                     : ctx.focusMode === 'thorough'  ? showThinkingSettings.thorough
                     : false
  const useThinking: boolean = !!(ctx.settings.useThinking) && ctx.focusMode === 'thorough'
  return { showThinking, researchModel: useThinking ? ctx.models.thinking : ctx.models.chat }
}

/** Context left for prefetched page text once the system prompt and history are counted. */
function urlBudgetChars(ctx: TurnContext, contextTokens: number, memoryBlock: string): number {
  const estSystemChars = 500 + (memoryBlock?.length ?? 0) + (additionalInstructions(ctx)?.length ?? 0)
  const estMsgsChars = ctx.msgs.reduce((s, m) => s + m.content.length, 0)
  return Math.max(0, contextCharBudget(contextTokens) - estSystemChars - estMsgsChars)
}

/** Pre-search, notes, memory, file and collection blocks, and raw URL prefetch.
 *
 *  In a locked space the two network legs are skipped outright rather than filtered later: the
 *  pre-search runs before the model is involved, and URL prefetching would fetch a link pasted
 *  beside the document without any tool being called at all.
 *  Notes first: the notes are read before the pre-search, which is skipped when they hold
 *  anything relevant — the researcher can still search the web for what they do not cover. */
async function gatherContext(ctx: TurnContext, searchBudget: SearchBudget, fetchMaxPages: number) {
  const userQuery = userQueryOf(ctx.msgs)
  const lastHasAttachment = hasAttachment(userQuery)
  const notesBlock = ctx.notesFirst ? await buildNotesBlock(ctx.userId, userQuery, await notesRagBudget(), ctx.locked) : { block: '', fileSources: [] }
  const [fileCountRow, { initialQueries, initialResults, engineErrors }, memoryBudget, ragBudget, prefetchedUrls] = await Promise.all([
    ctx.monitor ? Promise.resolve({ count: 0 }) : db.select({ count: sql<number>`count(*)` }).from(uploadedFiles).where(eq(uploadedFiles.userId, ctx.userId)).get(),
    preSearch(ctx, notesBlock.block, lastHasAttachment, searchBudget),
    ctx.spaceId ? getAppSetting('memory_token_budget', DEFAULT_MEMORY_TOKEN_BUDGET).then(Number) : Promise.resolve(Number(DEFAULT_MEMORY_TOKEN_BUDGET)),
    getAppSetting('space_rag_budget', '500').then(Number),
    ctx.locked ? Promise.resolve([]) : prefetchUrlsFromMessage(userQuery, lastHasAttachment, fetchMaxPages),
  ])
  const hasFiles = (fileCountRow?.count ?? 0) > 0
  const effectiveRag = (ctx.settings.useSpaceRag !== false) ? ragBudget : 0
  // Picked collections are the documents asked about: excerpts from all the user's files would repeat
  // theirs under a second label ([F1] and [C1] for one passage).
  const { block: scopedBlock, fileSources } = ctx.spaceId
    ? await buildMemoryBlock(ctx.spaceId, memoryBudget, effectiveRag, userQuery, ctx.includeFileIds, ctx.includeMemoryIds, ctx.locked)
    : (hasFiles && ctx.settings.useChatRag !== false && !ctx.collections.length)
      ? await buildChatFileBlock(ctx.userId, userQuery, ragBudget, !!notesBlock.block, ctx.locked)
      : { block: '', fileSources: [] }
  const collectionBlock = await buildCollectionBlock(ctx.collections, userQuery, await collectionRagBudget(ctx.collections), ctx.locked)
  // User memory applies to every chat, including those with no space at all.
  const memoryBlock = joinMemoryBlocks(
    await userMemoryBlockIfEnabled(ctx.userId, ctx.settings, userQuery),
    scopedBlock,
    collectionBlock.block,
    notesBlock.block,
  )
  return {
    initialQueries, initialResults, engineErrors, prefetchedUrls, hasFiles, memoryBlock,
    fileSources: [...fileSources, ...collectionBlock.fileSources, ...notesBlock.fileSources],
  }
}

/** Pre-search results, from a monitor's feed items when it has them. */
function preSearch(ctx: TurnContext, notesBlock: string, lastHasAttachment: boolean, searchBudget: SearchBudget) {
  const feedItems = ctx.monitor?.feedItems
  if (feedItems?.length) {
    return Promise.resolve({ initialQueries: ['latest news from selected RSS feeds'], initialResults: feedItems, engineErrors: [] as EngineError[] })
  }
  if (ctx.locked || notesBlock) {
    return Promise.resolve({ initialQueries: [] as string[], initialResults: [] as SearchResult[], engineErrors: [] as EngineError[] })
  }
  return runReformulateAndPreSearch(stripAttachments(ctx.msgs), ctx.focusMode as 'balanced' | 'thorough', lastHasAttachment, ctx.searchCategory, searchBudget, ctx.abortSignal)
}

/** Strip injected attachment content (everything after \n\n---\n) before reformulating,
 *  so the small model only sees the actual query and doesn't overflow its context. */
const stripAttachments = (msgs: TurnMessage[]) => msgs.map(m =>
  m.role === 'user'
    ? { ...m, content: m.content.replace(/\n\n---\n[\s\S]*$/, '').trim() }
    : m
)

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)]
    .map(m => m[0].replace(/[.,;!?]+$/, ''))
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, 2)
}

async function prefetchUrlsFromMessage(text: string, hasAttachment: boolean, maxPages = 8): Promise<ProcessedUrl[]> {
  if (hasAttachment) return []
  const urls = extractUrls(text)
  if (!urls.length) return []
  console.log(`  [fetch-url] pre-fetching ${urls.length} URL(s): ${urls.join(', ')}`)
  return Promise.all(urls.map(async url => ({ url, content: await fetchUrlAllPages(url, maxPages) })))
}

async function runReformulateAndPreSearch(
  msgsForReformulate: Array<{ role: string; content: string }>,
  focusMode: 'balanced' | 'thorough',
  hasAttachment: boolean,
  categories?: string,
  searchBudget?: SearchBudget,
  abortSignal?: AbortSignal,
): Promise<{ initialQueries?: string[]; initialResults?: SearchResult[]; engineErrors?: EngineError[] }> {
  // Dedup engine errors by name across the (possibly multiple) pre-search queries.
  const errByEngine = new Map<string, EngineError>()
  const collect = (errors: EngineError[]) => errors.forEach(e => errByEngine.set(e.engine, e))
  const engineErrors = () => [...errByEngine.values()]
  try {
    if (hasAttachment) {
      console.log(`  [chat] attachment detected — skipping reformulation/pre-search`)
      return {}
    }
    const queryReformulation = await getAppSetting('query_reformulation', 'true').then(v => v === 'true')
    if (!queryReformulation) {
      const q = userQueryOf(msgsForReformulate)
      if (!q) return {}
      console.log(`  [reformulate] disabled — using raw query: ${JSON.stringify(q.slice(0, 80))}`)
      const initialResults = await webSearch(q, 6, categories, collect, searchBudget)
      return { initialQueries: [q], initialResults, engineErrors: engineErrors() }
    }

    const countEach = focusMode === 'thorough' ? 10 : 6
    // reformulateLLM caps the list for the mode (and may add the raw query as a safety net), so
    // it is used as returned — slicing here again would drop that safety net.
    const queries = await reformulateLLM(msgsForReformulate, focusMode, abortSignal, searchBudget?.queriesRemaining)
    if (queries.length === 0) return {}

    const found = await webSearchMulti(queries, countEach, categories, collect, searchBudget)
    return { initialQueries: queries, initialResults: await rerankSearchResults(userQueryOf(msgsForReformulate), found), engineErrors: engineErrors() }
  } catch (e) {
    console.error('[reformulate] error:', e)
    return {}
  }
}
