import { streamText, tool } from 'ai'
import { z } from 'zod'
import { getChatModel } from './llm.ts'
import { webSearch } from './searxng.ts'
import { searchUploads } from './files/uploads-search.ts'

const RESEARCHER_SYSTEM = `You are a research assistant with access to web search and uploaded documents.

For each user query:
1. Decide if you need to search the web or uploaded files (skip if the answer is obvious from context).
2. Call tools as needed; gather relevant information.
3. Produce a clear, concise answer with inline citations [1], [2], etc.
4. If the query is conversational (greeting, math, date) answer directly without searching.

Available tools: web_search, uploads_search`

export interface ResearchOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  focusMode: 'speed' | 'balanced' | 'thorough'
  userId: string
}

export function runResearcher({ messages, focusMode, userId }: ResearchOptions) {
  const maxSteps = focusMode === 'speed' ? 2 : focusMode === 'thorough' ? 5 : 3

  return streamText({
    model: getChatModel(),
    system: RESEARCHER_SYSTEM,
    messages,
    maxSteps,
    tools: {
      web_search: tool({
        description: 'Search the web for up-to-date information.',
        parameters: z.object({
          query: z.string().describe('Search query'),
          count: z.number().optional().describe('Number of results (default 8)'),
        }),
        execute: async ({ query, count = 8 }) => {
          const results = await webSearch(query, count)
          return results
        },
      }),

      uploads_search: tool({
        description: 'Search uploaded documents belonging to the current user.',
        parameters: z.object({
          query: z.string().describe('Semantic search query'),
        }),
        execute: async ({ query }) => {
          return searchUploads(query, userId)
        },
      }),
    },
  })
}
