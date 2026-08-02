import { streamText, tool } from 'ai'
import { z } from 'zod'
import type { LanguageModel, CoreMessage } from 'ai'
import { webSearchMulti, type SearchResult, type EngineError, type SearchApiBudget } from './searxng.ts'
import { isSearchApiEnabled } from './search-api.ts'
import { searchUploads } from './files/uploads-search.ts'
import { saveMemory } from './memory.ts'
import { fetchUrl, processUrlsForContext, MIN_URL_CONTEXT_CHARS } from './fetch-url.ts'
import { trimMessages, contextCharBudget, CONTEXT_RESERVE_FRACTION } from './trim-messages.ts'
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

const MODE_CONFIG = {
  balanced: { maxSteps: 4, count: 8 },
  thorough: { maxSteps: 5, count: 10 },
}

// Returned from web_search once search is confirmed unavailable, so the model stops
// burning its remaining steps on futile searches and answers with what it already has.
const SEARCH_DEAD_MSG = {
  error: 'Web search is unavailable right now (search engines are blocked and the fallback search quota for this request is used up). Do NOT call web_search again — write your answer using the results already gathered.',
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
  /** Summarize (vs. truncate) URL content that overflows the context budget. Default false. */
  fetchSummarize?: boolean
  maxStepsOverride?: number
  /** Called when a web_search returns no results because engines were suspended/blocked. */
  onEngineErrors?: (errors: EngineError[]) => void | Promise<void>
  /** Shared per-request allowance for paid keyed-API fallback searches. */
  apiBudget?: SearchApiBudget
}

export function runResearcher({ messages, focusMode, userId, model, abortSignal, initialQueries, initialResults, prefetchedUrls, customPrompt, hasFiles, spaceId, sessionId, memoryBlock, fetchSummarize = false, maxStepsOverride, onEngineErrors, apiBudget }: ResearchOptions) {
  const { maxSteps: defaultMaxSteps, count } = MODE_CONFIG[focusMode]
  const maxSteps = maxStepsOverride ?? defaultMaxSteps
  let nextIndex = 1
  let searchDead = false   // set once web search is confirmed unavailable for this request
  const start = performance.now()
  console.log(`  [chat] model=${(model as LanguageModel & { modelId?: string }).modelId ?? String(model)} focusMode=${focusMode} maxSteps=${maxSteps}`)

  let system = `Today's date is ${new Date().toISOString().split('T')[0]}.`
  if (memoryBlock) system += '\n\n' + memoryBlock
  system += '\n\n' + SYSTEM_PROMPTS[focusMode]
  if (customPrompt?.trim()) system += `\n\nAdditional instructions from the user:\n${customPrompt.trim()}`
  if (hasFiles) system += `\n\nYou have an uploads_search tool to search the user's uploaded documents. When the query might be answered by personal, domain-specific, or proprietary documents, call uploads_search before or alongside web_search.`
  if (spaceId) system += `\n\nYou have a save_to_memory tool. Use it when the user expresses a preference, makes a decision, or shares context that would be useful in future conversations. Do not save trivial or ephemeral details.`

  // Inject pre-executed search results as a fake tool exchange so the model
  // sees them as already done and continues from there. Also note in the system
  // prompt that initial research has been done to discourage redundant searches.
  const cleanMessages = messages.map(m =>
    m.role === 'assistant'
      ? { ...m, content: typeof m.content === 'string' ? m.content.replace(/\[\d+\]/g, '') : m.content }
      : m
  )
  let augmentedMessages: CoreMessage[] = cleanMessages
  if (initialResults?.length && initialQueries?.length) {
    system += `\n\nNote: an initial search has already been performed and the results are in the conversation. Use different, more specific queries for your follow-up search.`
    const args = { queries: initialQueries }
    const indexedInitial = initialResults.map(r => ({ ...r, index: nextIndex++ }))
    augmentedMessages = [
      ...cleanMessages,
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'pre-0', toolName: 'web_search', args }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'pre-0', toolName: 'web_search', result: indexedInitial }] },
    ]
  }

  if (prefetchedUrls?.length) {
    system += `\n\nNote: the following URL(s) have already been fetched and their content is in the conversation. Use this content to answer the user's question directly.`
    for (let i = 0; i < prefetchedUrls.length; i++) {
      const { url, content } = prefetchedUrls[i]
      const callId = `pre-fetch-${i}`
      augmentedMessages = [
        ...augmentedMessages,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName: 'fetch_url', args: { url } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: 'fetch_url', result: content }] },
      ]
    }
  }

  const ctxLimit = parseInt(process.env.CONTEXT_TOKEN_LIMIT ?? '8192')
  augmentedMessages = trimMessages(augmentedMessages, Math.floor(ctxLimit * CONTEXT_RESERVE_FRACTION), system)

  // Cumulative budget for search/fetch content the agentic loop is about to add, derived from what's
  // left of the context window after the (already trimmed) system prompt + conversation history.
  const usedChars = system.length + augmentedMessages.reduce((s, m) => s + JSON.stringify(m).length, 0)
  let toolBudgetRemaining = Math.max(0, contextCharBudget(ctxLimit) - usedChars)
  console.log(`  [researcher] tool budget: ${toolBudgetRemaining}c remaining (ctxLimit=${ctxLimit}tok, system+history=${usedChars}c)`)

  const webSearchTool = tool({
    description: `Search the web. Provide up to ${focusMode === 'thorough' ? 3 : 2} queries covering different angles.`,
    parameters: z.object({
      queries: z.array(z.string()).describe('Search queries'),
    }),
    execute: async ({ queries }) => {
      if (searchDead) return SEARCH_DEAD_MSG
      if (toolBudgetRemaining <= MIN_URL_CONTEXT_CHARS) return CONTEXT_BUDGET_DEAD_MSG
      const errs: EngineError[] = []
      const results = await webSearchMulti(queries.slice(0, focusMode === 'thorough' ? 3 : 2), count, undefined, e => errs.push(...e), apiBudget)
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {
    web_search: webSearchTool,
    fetch_url: tool({
      description: 'Fetch and read the full text content of a specific URL. Use when the user provides a URL to analyze, or when a search result needs to be read in full. For paginated content, call multiple times with page parameters (e.g. ?page=2).',
      parameters: z.object({ url: z.string().url() }),
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
      parameters: z.object({
        query: z.string().describe('Semantic search query'),
      }),
      execute: async ({ query }) => searchUploads(query, userId),
    })
  }

  if (focusMode === 'thorough') {
    tools.done = tool({
      description: 'Signal that research is complete. Call this when you have gathered enough information.',
      parameters: z.object({}),
      execute: async () => ({ done: true }),
    })
  }

  if (spaceId) {
    tools.save_to_memory = tool({
      description: 'Save a noteworthy fact, preference, or decision to the space memory for future conversations. Keep entries concise (1-2 sentences).',
      parameters: z.object({ fact: z.string().describe('The fact to remember') }),
      execute: async ({ fact }) => {
        console.log(`  [memory] save_to_memory tool called: "${fact.slice(0, 80)}"`)
        await saveMemory(spaceId, fact, 'tool', sessionId)
        return 'Saved.'
      },
    })
  }

  const fmt = (n: number | undefined) => (n != null && !isNaN(n)) ? String(n) : '?'
  let stepIndex = 0
  return streamText({
    onError: ({ error }) => {
      console.error('  [chat] streamText error:', error)
    },
    onStepFinish: (step) => {
      stepIndex++
      const toolSummary = step.toolCalls.map(c => {
        const result = step.toolResults.find(tr => tr.toolCallId === c.toolCallId)?.result
        const size = typeof result === 'string' ? result.length : JSON.stringify(result ?? '').length
        return `${c.toolName}(${size}c)`
      }).join(', ')
      console.log(`  [chat] step ${stepIndex}: ${fmt(step.usage.promptTokens)}p + ${fmt(step.usage.completionTokens)}c tok, finish=${step.finishReason}${toolSummary ? ` tools=[${toolSummary}]` : ''} budget=${toolBudgetRemaining}c`)
    },
    onFinish: ({ usage }) => {
      const ms = (performance.now() - start).toFixed(0)
      console.log(`  [chat] done — ${ms}ms  tokens: ${fmt(usage.promptTokens)}p + ${fmt(usage.completionTokens)}c`)
    },
    model,
    abortSignal,
    system,
    messages: augmentedMessages,
    maxSteps,
    maxTokens: RESEARCH_MAX_TOKENS,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools as any,
  })
}
