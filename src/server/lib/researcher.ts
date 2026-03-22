import { streamText, tool } from 'ai'
import { z } from 'zod'
import { getChatModel } from './llm.ts'
import { webSearch, webSearchMulti, type SearchResult } from './searxng.ts'
import { searchUploads } from './files/uploads-search.ts'

const CHAT_TARGET = `${process.env.CHAT_BASE_URL ?? 'ollama'} model=${process.env.CHAT_MODEL ?? 'llama3.2'}`

export const SYSTEM_PROMPTS = {
  fast: `You are a fast research assistant. Answer directly. If a web search would help, \
call web_search once with the most important query. Skip search for conversational \
or factual questions you can answer from training.
Format your answer for readability: use short paragraphs, bullet lists, or headings when the answer has multiple points or is more than two sentences. Avoid dense walls of text. Be concise.
Always respond in the same language the user used.`,

  balanced: `You are a research assistant. For each query:
1. Review the search results you already have.
2. Before answering, ALWAYS call web_search at least once more with targeted follow-up queries to fill gaps or verify key claims. Do NOT skip this step.
3. After the follow-up search, write your answer with inline [N] citations (e.g. [1][2]). Do NOT use markdown hyperlinks.
4. Only cite [N] when the specific fact is directly supported by that result's content. Skip irrelevant results.
5. NEVER use [N] citations for information from your training knowledge. If results are irrelevant, answer without any [N] citations.
Use web_search with up to 2 queries at a time.
Format your answer for readability: use short paragraphs, bullet lists, or headings when the answer has multiple points. Avoid dense walls of text.
Always respond in the same language the user used.`,

  thorough: `You are a thorough research assistant. For each query:
1. Explore multiple angles: definitions, current state, comparisons, recent news, expert views.
2. Use up to 3 queries per call, covering different aspects.
3. Cross-reference information across sources.
4. Prefer specific, targeted queries over broad ones after the first iteration.
5. Only cite [N] when the specific fact is directly supported by that result's content. Skip irrelevant results.
Call web_search as many times as needed. Do NOT write your answer yet — just research.
When done researching, call the done tool.
Format your final answer for readability: use headings, bullet lists, and short paragraphs to organize information clearly. Avoid dense walls of text.
Always respond in the same language the user used.`,
}

const MODE_CONFIG = {
  fast:    { maxSteps: 2, count: 6 },
  balanced: { maxSteps: 3, count: 8 },
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

  let system = `Today's date is ${new Date().toISOString().split('T')[0]}.\n\n` + SYSTEM_PROMPTS[focusMode]
  if (customPrompt?.trim()) system += `\n\nAdditional instructions from the user:\n${customPrompt.trim()}`

  // Inject pre-executed search results as a fake tool exchange so the model
  // sees them as already done and continues from there. Also note in the system
  // prompt that initial research has been done to discourage redundant searches.
  const cleanMessages = messages.map(m =>
    m.role === 'assistant'
      ? { ...m, content: typeof m.content === 'string' ? m.content.replace(/\[\d+\]/g, '') : m.content }
      : m
  )
  let augmentedMessages: any[] = cleanMessages
  if (initialResults?.length && initialQueries?.length) {
    system += `\n\nNote: an initial search has already been performed and the results are in the conversation. Use different, more specific queries for your follow-up search.`
    const args = focusMode === 'fast'
      ? { query: initialQueries[0] }
      : { queries: initialQueries }
    augmentedMessages = [
      ...cleanMessages,
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
