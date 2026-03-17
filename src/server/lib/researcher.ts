import { streamText, tool } from 'ai'
import { z } from 'zod'
import { getChatModel } from './llm.ts'
import { webSearch, webSearchMulti, type SearchResult } from './searxng.ts'
import { searchUploads } from './files/uploads-search.ts'

const CHAT_TARGET = `${process.env.CHAT_BASE_URL ?? 'ollama'} model=${process.env.CHAT_MODEL ?? 'llama3.2'}`

export const SYSTEM_PROMPTS = {
  fast: `You are a fast research assistant. Answer directly. If a web search would help, \
call web_search once with the most important query. Skip search for conversational \
or factual questions you can answer from training. Be concise.`,

  balanced: `You are a research assistant. For each query:
1. Start with 1-2 broad queries to get an overview.
2. Based on results, optionally refine with more specific queries.
3. Answer clearly with inline citations [1][2].
Use web_search with up to 2 queries at a time. Stop when you have enough information.`,

  thorough: `You are a thorough research assistant. For each query:
1. Explore multiple angles: definitions, current state, comparisons, recent news, expert views.
2. Use up to 3 queries per call, covering different aspects.
3. Cross-reference information across sources.
4. Prefer specific, targeted queries over broad ones after the first iteration.
Call web_search as many times as needed. Do NOT write your answer yet — just research.
When done researching, call the done tool.`,
}

const MODE_CONFIG = {
  fast:    { maxSteps: 2, count: 6 },
  balanced: { maxSteps: 4, count: 8 },
  thorough: { maxSteps: 5, count: 10 },
}

export interface ResearchOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  focusMode: 'fast' | 'balanced' | 'thorough'
  userId: string
  initialQueries?: string[]
  initialResults?: SearchResult[]
  customPrompt?: string
  hasFiles?: boolean
}

export function runResearcher({ messages, focusMode, userId, initialQueries, initialResults, customPrompt, hasFiles }: ResearchOptions) {
  const { maxSteps, count } = MODE_CONFIG[focusMode]
  const start = performance.now()
  console.log(`  [chat] ${CHAT_TARGET} focusMode=${focusMode} maxSteps=${maxSteps}`)

  let system = SYSTEM_PROMPTS[focusMode]
  if (customPrompt?.trim()) system += `\n\nAdditional instructions from the user:\n${customPrompt.trim()}`

  // Inject pre-executed search results as a fake tool exchange so the model
  // sees them as already done and continues from there. Also note in the system
  // prompt that initial research has been done to discourage redundant searches.
  let augmentedMessages: any[] = messages
  if (initialResults?.length && initialQueries?.length) {
    system += `\n\nNote: an initial search has already been performed and the results are in the conversation. Build on those results rather than repeating the same queries.`
    const args = focusMode === 'fast'
      ? { query: initialQueries[0] }
      : { queries: initialQueries }
    augmentedMessages = [
      ...messages,
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'pre-0', toolName: 'web_search', args }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'pre-0', toolName: 'web_search', result: initialResults }] },
    ]
  }

  const webSearchTool = focusMode === 'fast'
    ? tool({
        description: 'Search the web for up-to-date information.',
        parameters: z.object({
          query: z.string().describe('Search query'),
        }),
        execute: async ({ query }) => webSearch(query, count),
      })
    : tool({
        description: `Search the web. Provide up to ${focusMode === 'thorough' ? 3 : 2} queries covering different angles.`,
        parameters: z.object({
          queries: z.array(z.string()).describe('Search queries'),
        }),
        execute: async ({ queries }) =>
          webSearchMulti(queries.slice(0, focusMode === 'thorough' ? 3 : 2), count),
      })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = { web_search: webSearchTool }

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

  return streamText({
    onFinish: ({ usage }) => {
      const ms = (performance.now() - start).toFixed(0)
      const fmt = (n: number | undefined) => (n != null && !isNaN(n)) ? String(n) : '?'
      console.log(`  [chat] done — ${ms}ms  tokens: ${fmt(usage.promptTokens)}p + ${fmt(usage.completionTokens)}c`)
    },
    model: getChatModel(),
    system,
    messages: augmentedMessages,
    maxSteps,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools as any,
  })
}
