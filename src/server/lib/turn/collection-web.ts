import { tool } from 'ai'
import { z } from 'zod'
import { webSearch, newSearchBudget, type SearchResult, type SearchBudget } from '../search/index.ts'
import { applyEgressMode, createEgressContext, inspectQuery, noteSeenUrl, noteTaint, noteUserText, type EgressContext } from '../egress-guard.ts'
import type { Gathered } from './collection-evidence.ts'
import type { TurnContext, TurnSink } from './context.ts'

/** Explore's opt-in web search: a tool for context the documents lack (a work they cite, whether
 *  something has since changed), its results numbered [1]… for the answer. Off in a locked turn.
 *  Every query is screened as the researcher's are: the agent has read the documents, so a query
 *  can carry their text out — an uncertain one is put to the user, a clear one refused. */

const RESULTS_PER_QUERY = 5
const SNIPPET_CHARS = 300

export interface WebSearching {
  results: SearchResult[]
  egress: EgressContext
  budget: SearchBudget
  /** Read parts and passages already marked as document text for the guard, by key. */
  tainted: Set<string>
}

/** The web state for a turn that asked for it, or undefined when it did not or is locked. */
export async function startWeb(ctx: TurnContext): Promise<WebSearching | undefined> {
  if (!ctx.exploreWeb || ctx.locked) return undefined
  const egress = createEgressContext()
  for (const m of ctx.msgs) if (m.role === 'user') noteUserText(egress, m.content)
  return { results: [], egress, budget: await newSearchBudget('balanced'), tainted: new Set() }
}

export const EXPLORE_WEB_INSTRUCTION = `\nYou also have web_search, for context the documents lack — a work they cite, how a term is used elsewhere, whether something has changed since. Explore the documents first; the web never stands in for them, and searching it is not needed for most messages.`

/** The web_search tool. Results go to the model and are kept, numbered, for the answer. */
export function webSearchTool(ctx: TurnContext, sink: TurnSink, web: WebSearching, gathered: Gathered) {
  return tool({
    description: 'Search the web. Only for context the documents lack; returns titles, URLs and snippets.',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      taintGathered(web, gathered)
      if (!await permitted(query, web, sink)) return 'That search was not allowed: it looks like it carries document text. Continue with the documents.'
      await sink.step({ kind: 'search', queries: [`${query} (web)`] })
      const found = await webSearch(query, RESULTS_PER_QUERY, undefined, undefined, web.budget)
      if (!found.length) return web.budget.queriesRemaining <= 0 ? 'The search limit is reached. Continue with the documents.' : 'Nothing found.'
      for (const r of found) {
        noteSeenUrl(web.egress, r.url)
        if (!web.results.some(s => s.url === r.url)) web.results.push(r)
      }
      return found.map(r => `${r.title} (${r.url}): ${(r.content ?? '').slice(0, SNIPPET_CHARS)}`).join('\n\n')
    },
  })
}

/** Marks what the agent has read as document text, so the guard can tell a query that copies it. */
function taintGathered(web: WebSearching, gathered: Gathered) {
  const items: Array<[string, string]> = [
    ...[...gathered.reads].map(([key, r]): [string, string] => [`read:${key}`, r.text]),
    ...[...gathered.seen].map(([key, s]): [string, string] => [`seen:${key}`, s.text]),
  ]
  for (const [key, text] of items) {
    if (web.tainted.has(key)) continue
    web.tainted.add(key)
    noteTaint(web.egress, text)
  }
}

/** The guard's verdict, asking the user when it is uncertain; no one to ask means no. */
async function permitted(query: string, web: WebSearching, sink: TurnSink): Promise<boolean> {
  const v = applyEgressMode(inspectQuery(query, web.egress), 'search', query)
  if (v.action === 'allow') return true
  if (v.action === 'block' || !sink.requestApproval) return false
  return sink.requestApproval({ kind: 'search', target: query, reasons: v.reasons })
}

/** The web results for the answer, numbered as the sources panel numbers them. */
export function webBlock(web: WebSearching | undefined): string {
  if (!web?.results.length) return ''
  const lines = web.results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${(r.content ?? '').slice(0, SNIPPET_CHARS)}`)
  return `## Web results
${lines.join('\n\n')}
These are from the web, not the documents: use them only for context the documents lack, cite them as [1], [2]…, and never present them as what a document says. Bracketed numbers inside the documents' own text are their references, not these.`
}
