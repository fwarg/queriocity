import { streamText, tool, type ToolSet, stepCountIs, hasToolCall } from 'ai'
import { z } from 'zod'
import type { LanguageModel, ModelMessage } from 'ai'
import { webSearchMulti, type SearchResult, type EngineError, type SearchApiBudget } from './searxng.ts'
import { isSearchApiEnabled } from './search-api.ts'
import { searchUploads } from './files/uploads-search.ts'
import { saveMemories, saveUserMemory, searchSpaceHistory } from './memory.ts'
import { fetchUrl, processUrlsForContext, MIN_URL_CONTEXT_CHARS } from './fetch-url.ts'
import { trimMessages, compressMessages, contextCharBudget, CONTEXT_RESERVE_FRACTION } from './trim-messages.ts'
import { queryTerms, querySimilarity, QUERY_DUPLICATE_THRESHOLD } from './query-terms.ts'
import { RESEARCH_MAX_TOKENS } from './llm.ts'


export const SYSTEM_PROMPTS = {
  balanced: `You are a research assistant. For each query:
1. Review the search results you already have.
2. Before answering, call web_search once more if the current results have gaps or are insufficient to fully answer the question. If the initial results already cover the question well, you may skip this. If the user provides a specific URL, call fetch_url to read its full content instead of or in addition to searching.
3. After the follow-up search, write your answer with inline [N] citations where N is the exact \`index\` value of that result (e.g. [1][2]). Do NOT use markdown hyperlinks. NEVER invent your own numbering — only use index values that appear in the search results.
4. Only cite [N] when the specific fact is directly supported by that result's content. Skip irrelevant results.
5. NEVER use [N] citations for information from your training knowledge. If results are irrelevant, answer without any [N] citations.
Search results are authoritative ground truth. If results describe a product, release, or name you don't recognise, trust the results — your training data has a cutoff and does not know about recent releases. Never deny that something exists based on your training knowledge alone.
Use web_search with up to 2 queries at a time.
Format your answer for readability: use short paragraphs, bullet lists, or headings when the answer has multiple points. Avoid dense walls of text.
Always respond in the same language the user used.`,

  thorough: `You are a thorough research assistant. For each query:
1. Explore multiple angles: definitions, current state, comparisons, recent news, expert views.
2. Use up to 3 queries per call, covering different aspects.
3. Cross-reference information across sources.
4. Prefer specific, targeted queries over broad ones after the first iteration.
5. Only cite [N] when the specific fact is directly supported by that result's content. Skip irrelevant results. Do NOT include a reference list or source list at the end of your notes.
6. If the user provides a specific URL, call fetch_url to read its full content. For paginated content (forums, articles), you MUST fetch ALL pages before answering — keep calling fetch_url with ?page=2, ?page=3, etc. until you get an error or empty content. Do not stop after one or two pages.
Search results are authoritative ground truth. If results describe a product, release, or name you don't recognise, trust the results — your training data has a cutoff and does not know about recent releases. Never deny that something exists based on your training knowledge alone.
Call web_search as many times as needed. Do NOT write your answer yet — just research.
When done researching, call the done tool.
Format your final answer for readability: use headings, bullet lists, and short paragraphs to organize information clearly. Avoid dense walls of text.
Always respond in the same language the user used.`,
}

/** Appended to the system prompt on the step where prepareStep withholds the tools.
 *
 *  Withholding alone leaves the prompt telling the model to call web_search while giving it no
 *  way to, and a tool-trained model obeys the instruction the only way left: it writes the call
 *  as prose. Nothing catches that — the request carried no tool schemas, so the provider's
 *  tool-call parser is off and the markup streams to the user as the answer. */
const FINAL_STEP_INSTRUCTION = `

Your tools have now been withdrawn for this final step: there is no search left to run and no way to call one. Write the answer now from the search results already in this conversation, and ignore any instruction above to search first.
Never emit a tool call in any syntax. There is nothing to parse it, so it would be shown to the user as your answer.
If the results do not fully cover the question, answer with what they do support and close with one short line naming what is missing. Never reply with only a refusal.`

// balanced spends its last step writing (see the prepareStep reserve below), so 3 steps buys
// 2 rounds of tool calls. It was 4 while the reserve cost two steps; keeping 4 once the reserve
// dropped to one would have widened balanced's budget rather than made it cheaper, and the
// point of balanced is to be faster than thorough.
const MODE_CONFIG = {
  balanced: { maxSteps: 3, count: 8 },
  thorough: { maxSteps: 5, count: 10 },
}

// Fraction of the total input budget reserved for agentic tool (web_search/fetch_url) results,
// held back from history trimming so a long conversation can't leave the tools starved of room,
// however much history exists.
const TOOL_BUDGET_RESERVE_FRACTION = parseFloat(process.env.TOOL_BUDGET_RESERVE_FRACTION ?? '0.3')
// Fraction of the history sub-budget the small-model summary of dropped messages may itself
// consume when history compression is enabled (comes out of that sub-budget, not additive).
const COMPRESS_SUMMARY_FRACTION = 0.12

// Returned from web_search once search is confirmed unavailable, so the model stops
// burning its remaining steps on futile searches and answers with what it already has.
const SEARCH_DEAD_MSG = {
  error: 'Web search is unavailable right now (search engines are blocked and the fallback search quota for this request is used up). Do NOT call web_search again — write your answer using the results already gathered.',
}

// Returned when every query in a web_search call repeats one already run. Names the constraint
// rather than returning an empty array, which the model reads as "nothing exists on this topic".
const DUPLICATE_QUERY_MSG = {
  error: 'Every query in this call repeats a search already performed this turn, so it was not run. The results you already have are all these queries would return. Either search a genuinely different angle — a different entity, time period, or sub-question — or write your answer now.',
}

// Returned from fetch_url/web_search once the shared per-turn context budget is used up,
// so the model stops requesting more content and answers with what it already has.
const CONTEXT_BUDGET_DEAD_MSG = {
  error: 'The available context budget for this research turn has been used up by search/fetch results already gathered. Do NOT call web_search or fetch_url again — write your answer using the results already gathered.',
}

export interface ResearchOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  focusMode: 'balanced' | 'thorough'
  userId: string
  model: LanguageModel
  abortSignal?: AbortSignal
  initialQueries?: string[]
  initialResults?: SearchResult[]
  prefetchedUrls?: Array<{ url: string; content: string }>
  customPrompt?: string
  hasFiles?: boolean
  spaceId?: string
  sessionId?: string
  memoryBlock?: string
  /** Whether the user opted into user-level memory; gates the save_user_fact tool. */
  userMemoryEnabled?: boolean
  /** Summarize (vs. truncate) URL content that overflows the context budget. Default false. */
  fetchSummarize?: boolean
  /** Summarize (vs. hard-drop) conversation history that overflows the context budget. Default false. */
  compressHistory?: boolean
  /** SearXNG category filter selected by the user; applies to the researcher's own searches
   *  too, not just the pre-search, or the model's follow-ups silently query a different
   *  engine set than the one the user asked for. */
  searchCategory?: string
  maxStepsOverride?: number
  /** Called when a web_search returns no results because engines were suspended/blocked. */
  onEngineErrors?: (errors: EngineError[]) => void | Promise<void>
  /** Shared per-request allowance for paid keyed-API fallback searches. */
  apiBudget?: SearchApiBudget
}

export async function runResearcher({ messages, focusMode, userId, model, abortSignal, initialQueries, initialResults, prefetchedUrls, customPrompt, hasFiles, spaceId, sessionId, memoryBlock, userMemoryEnabled = false, fetchSummarize = false, compressHistory = false, searchCategory, maxStepsOverride, onEngineErrors, apiBudget }: ResearchOptions) {
  const { maxSteps: defaultMaxSteps, count } = MODE_CONFIG[focusMode]
  const maxSteps = maxStepsOverride ?? defaultMaxSteps
  let nextIndex = 1
  let searchDead = false   // set once web search is confirmed unavailable for this request
  let completedSteps = 0
  // Term sets of every query already run this turn, pre-search included — the model is told the
  // initial search happened but still re-runs variants of it. See QUERY_DUPLICATE_THRESHOLD.
  const executedQueries: Array<Set<string>> = (initialQueries ?? []).map(queryTerms)

  // A tool result arriving on the final generation can never be used — the model has no step
  // left to write prose, so the turn ends on finishReason=tool-calls with an empty answer.
  // The last step is therefore reserved for writing, by withholding the tools rather than by
  // letting the call happen and refusing it: a refused call still consumes the step, which is
  // why this used to cost *two* steps instead of one. Thorough mode is exempt — its researcher
  // is meant to end without prose, and the writer pass follows.
  const reserveWritingStep = focusMode === 'balanced' && maxSteps > 1
  const isFinalStep = (stepNumber: number) => stepNumber >= maxSteps - 1
  const start = performance.now()
  console.log(`  [chat] model=${(model as LanguageModel & { modelId?: string }).modelId ?? String(model)} focusMode=${focusMode} maxSteps=${maxSteps}`)

  let system = `Today's date is ${new Date().toISOString().split('T')[0]}.`
  if (memoryBlock) system += '\n\n' + memoryBlock
  system += '\n\n' + SYSTEM_PROMPTS[focusMode]
  if (customPrompt?.trim()) system += `\n\nAdditional instructions from the user:\n${customPrompt.trim()}`
  if (hasFiles) system += `\n\nYou have an uploads_search tool to search the user's uploaded documents. When the query might be answered by personal, domain-specific, or proprietary documents, call uploads_search before or alongside web_search.`
  if (spaceId) system += `\n\nYou have a save_to_memory tool. Use it when the user expresses a preference, makes a decision, or shares context that would be useful in future conversations. Do not save trivial or ephemeral details.`
  if (userMemoryEnabled) system += `\n\nYou have a save_user_fact tool for facts about the user that hold in *every* conversation — how they want answers written, languages they work in, durable constraints. Use it rarely: anything topic-specific belongs in save_to_memory instead.`
  if (spaceId) system += `\n\nYou also have a search_space_history tool for looking up earlier conversations in this space. Relevant excerpts are already provided above when they exist, so call it only when the user refers to something earlier that is not covered there.`

  // Inject pre-executed search results as a fake tool exchange so the model
  // sees them as already done and continues from there. Also note in the system
  // prompt that initial research has been done to discourage redundant searches.
  const cleanMessages = messages.map(m =>
    m.role === 'assistant'
      ? { ...m, content: typeof m.content === 'string' ? m.content.replace(/\[\d+\]/g, '') : m.content }
      : m
  )
  let augmentedMessages: ModelMessage[] = cleanMessages
  if (initialResults?.length && initialQueries?.length) {
    system += `\n\nNote: an initial search has already been performed and the results are in the conversation. Use different, more specific queries for your follow-up search.`
    const args = { queries: initialQueries }
    const indexedInitial = initialResults.map(r => ({ ...r, index: nextIndex++ }))
    augmentedMessages = [
      ...cleanMessages,
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'pre-0', toolName: 'web_search', input: args }] },
      // v5+ wraps a tool result in a tagged output: structured results go as 'json', not raw.
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'pre-0', toolName: 'web_search', output: { type: 'json', value: indexedInitial } }] },
    ]
  }

  if (prefetchedUrls?.length) {
    system += `\n\nNote: the following URL(s) have already been fetched and their content is in the conversation. Use this content to answer the user's question directly.`
    for (let i = 0; i < prefetchedUrls.length; i++) {
      const { url, content } = prefetchedUrls[i]
      const callId = `pre-fetch-${i}`
      augmentedMessages = [
        ...augmentedMessages,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName: 'fetch_url', input: { url } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: 'fetch_url', output: { type: 'text', value: content } }] },
      ]
    }
  }

  const ctxLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
  // Reserve TOOL_BUDGET_RESERVE_FRACTION of the total input budget for tools up front, so history
  // trimming can never eat into the room tools need, however long the conversation is.
  const totalInputTokens = ctxLimit * CONTEXT_RESERVE_FRACTION
  const historyBudgetTokens = Math.floor(totalInputTokens * (1 - TOOL_BUDGET_RESERVE_FRACTION))

  if (compressHistory) {
    const summaryBudgetChars = Math.floor(historyBudgetTokens * 4 * COMPRESS_SUMMARY_FRACTION)
    // Reserve the summary's own cost out of the history sub-budget up front, so kept-messages +
    // summary together still respect historyBudgetTokens.
    const dropBudgetTokens = historyBudgetTokens - Math.ceil(summaryBudgetChars / 4)
    const { messages: compressedMessages, summary } = await compressMessages(augmentedMessages, dropBudgetTokens, system, summaryBudgetChars)
    augmentedMessages = compressedMessages
    if (summary) system += `\n\nSummary of earlier parts of this conversation (older messages were compacted to fit context):\n${summary}`
  } else {
    augmentedMessages = trimMessages(augmentedMessages, historyBudgetTokens, system)
  }

  // Cumulative budget for search/fetch content the agentic loop is about to add, derived from what's
  // left of the context window after the (already trimmed/compressed) system prompt + conversation history.
  const usedChars = system.length + augmentedMessages.reduce((s, m) => s + JSON.stringify(m).length, 0)
  let toolBudgetRemaining = Math.max(0, contextCharBudget(ctxLimit) - usedChars)
  console.log(`  [researcher] tool budget: ${toolBudgetRemaining}c remaining (ctxLimit=${ctxLimit}tok, historyBudget=${historyBudgetTokens}tok, system+history=${usedChars}c)`)

  const webSearchTool = tool({
    description: `Search the web. Provide up to ${focusMode === 'thorough' ? 3 : 2} queries covering different angles.`,
    inputSchema: z.object({
      queries: z.array(z.string()).describe('Search queries'),
    }),
    execute: async ({ queries }) => {
      if (searchDead) return SEARCH_DEAD_MSG
      if (toolBudgetRemaining <= MIN_URL_CONTEXT_CHARS) return CONTEXT_BUDGET_DEAD_MSG
      const requested = queries.slice(0, focusMode === 'thorough' ? 3 : 2)
      // Drop queries that merely rephrase one already run — including within this same call,
      // where the model sometimes asks for two near-identical angles at once.
      const fresh: string[] = []
      const skipped: string[] = []
      for (const q of requested) {
        const terms = queryTerms(q)
        if (executedQueries.some(prev => querySimilarity(terms, prev) >= QUERY_DUPLICATE_THRESHOLD)) {
          skipped.push(q)
          continue
        }
        executedQueries.push(terms)
        fresh.push(q)
      }
      if (skipped.length) console.log(`  [researcher] skipped ${skipped.length} duplicate quer${skipped.length === 1 ? 'y' : 'ies'}: ${skipped.map(q => JSON.stringify(q)).join(', ')}`)
      if (!fresh.length) return DUPLICATE_QUERY_MSG
      const errs: EngineError[] = []
      const results = await webSearchMulti(fresh, count, searchCategory, e => errs.push(...e), apiBudget)
      // Surface only when blocked engines left this search empty (matches pre-search semantics).
      if (results.length === 0 && errs.length) {
        await onEngineErrors?.(errs)
        // Engines are blocked and the paid fallback can't help (disabled or budget spent) →
        // every further search will also be empty. Stop the model from spinning on them.
        if (!isSearchApiEnabled() || (apiBudget?.remaining ?? 0) <= 0) {
          searchDead = true
          console.log('  [researcher] search exhausted — instructing model to stop searching')
          return SEARCH_DEAD_MSG
        }
      }
      const indexed = results.map(r => ({ ...r, index: nextIndex++ }))
      toolBudgetRemaining -= JSON.stringify(indexed).length
      return indexed
    },
  })

  // A ToolSet rather than Record<string, any>: typing it lets the stream parts downstream keep
  // the SDK's real union type, so a future SDK field rename is a compile error instead of a
  // silent `undefined` (see drainResearcherStream in routes/chat.ts).
  const tools: ToolSet = {
    web_search: webSearchTool,
    fetch_url: tool({
      description: 'Fetch and read the full text content of a specific URL. Use when the user provides a URL to analyze, or when a search result needs to be read in full. For paginated content, call multiple times with page parameters (e.g. ?page=2).',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
          if (toolBudgetRemaining <= MIN_URL_CONTEXT_CHARS) return CONTEXT_BUDGET_DEAD_MSG
        const raw = await fetchUrl(url)
        if (raw.startsWith('Error fetching')) return raw
        const [{ content }] = await processUrlsForContext([{ url, content: raw }], toolBudgetRemaining, fetchSummarize)
        toolBudgetRemaining -= content.length
        return content
      },
    }),
  }

  if (hasFiles) {
    tools.uploads_search = tool({
      description: 'Search uploaded documents belonging to the current user.',
      inputSchema: z.object({
        query: z.string().describe('Semantic search query'),
      }),
      execute: async ({ query }) => searchUploads(query, userId),
    })
  }

  if (focusMode === 'thorough') {
    tools.done = tool({
      description: 'Signal that research is complete. Call this when you have gathered enough information.',
      inputSchema: z.object({}),
      execute: async () => ({ done: true }),
    })
  }

  if (spaceId) {
    tools.save_to_memory = tool({
      description: 'Save a noteworthy fact, preference, or decision to the space memory for future conversations. Keep entries concise (1-2 sentences).',
      inputSchema: z.object({ fact: z.string().describe('The fact to remember') }),
      execute: async ({ fact }) => {
        console.log(`  [memory] save_to_memory tool called: "${fact.slice(0, 80)}"`)
        // saveMemories, not saveMemory: a single fact still goes through conflict resolution, so
        // "I moved to SQLite" supersedes "I use Postgres" instead of sitting beside it.
        await saveMemories(spaceId, [fact], 'tool', sessionId)
        return 'Saved.'
      },
    })

    tools.search_space_history = tool({
      description: 'Search past conversations in this space for relevant context (e.g. what was decided or discussed earlier). Relevant excerpts are already injected automatically — only call this when you need something they do not cover.',
      inputSchema: z.object({
        query: z.string().describe('Semantic search query'),
      }),
      execute: async ({ query }) => searchSpaceHistory(spaceId, query, 8, sessionId),
    })
  }

  // Registered only on opt-in, so the default tool count — and the prompt space it costs — is
  // unchanged for everyone else.
  if (userMemoryEnabled) {
    tools.save_user_fact = tool({
      description: 'Save a durable fact about the user that applies to every future conversation, not just this topic: how they want answers written, languages they work in, lasting constraints. Use sparingly.',
      inputSchema: z.object({ fact: z.string().describe('The durable fact about the user') }),
      execute: async ({ fact }) => {
        console.log(`  [memory] save_user_fact tool called: "${fact.slice(0, 80)}"`)
        await saveUserMemory(userId, fact, 'tool')
        return 'Saved.'
      },
    })
  }

  const fmt = (n: number | undefined) => (n != null && !isNaN(n)) ? String(n) : '?'
  return streamText({
    onError: ({ error }) => {
      console.error('  [chat] streamText error:', error)
    },
    onStepFinish: (step) => {
      completedSteps++
      // Diagnostic only. A generic ToolSet gives no per-tool result type (the union collapses
      // to never), so narrow structurally here rather than weakening the tools type itself.
      // The field is `output` from v5 on (`result` in v4) — this cast is a compiler blind spot,
      // so if every tool starts logging (2c) the field has been renamed again.
      const toolResults = step.toolResults as unknown as Array<{ toolCallId: string; output?: unknown }>
      const toolSummary = step.toolCalls.map(c => {
        const output = toolResults.find(tr => tr.toolCallId === c.toolCallId)?.output
        const size = typeof output === 'string' ? output.length : JSON.stringify(output ?? '').length
        return `${c.toolName}(${size}c)`
      }).join(', ')
      console.log(`  [chat] step ${completedSteps}: ${fmt(step.usage.inputTokens)}p + ${fmt(step.usage.outputTokens)}c tok, finish=${step.finishReason}${toolSummary ? ` tools=[${toolSummary}]` : ''} budget=${toolBudgetRemaining}c`)
    },
    onFinish: ({ usage }) => {
      const ms = (performance.now() - start).toFixed(0)
      console.log(`  [chat] done — ${ms}ms  tokens: ${fmt(usage.inputTokens)}p + ${fmt(usage.outputTokens)}c`)
    },
    model,
    abortSignal,
    system,
    messages: augmentedMessages,
    // `done` is thorough's "research finished" signal. Without it as a stop condition the tool
    // returns {done:true} and the loop keeps going to the step cap, so every run that finished
    // early still paid for the remaining steps. Harmless in balanced, which registers no `done`.
    stopWhen: [stepCountIs(maxSteps), hasToolCall('done')],
    maxOutputTokens: RESEARCH_MAX_TOKENS,
    tools,
    // Withhold the tools on the final step so it can only produce prose. `activeTools: []`
    // rather than `toolChoice: 'none'` so the schemas are not sent at all — the model cannot
    // be tempted by a tool it can no longer usefully call, and the last prompt is smaller.
    // The prompt has to be told as well, or the two contradict each other — see
    // FINAL_STEP_INSTRUCTION.
    prepareStep: ({ stepNumber }) => {
      if (reserveWritingStep && isFinalStep(stepNumber)) {
        console.log(`  [chat] step ${stepNumber + 1}/${maxSteps}: tools withheld — final step is for the answer`)
        return { activeTools: [], instructions: system + FINAL_STEP_INSTRUCTION }
      }
      return {}
    },
  })
}
