/** What one chat turn runs on, and where its output goes — shared by the chat route and monitors. */

import type { EgressApprovalRequest } from '../researcher.ts'
import type { SSEStream } from '../researcher-stream.ts'
import type { ModelTarget, TurnModels } from '../llm.ts'
import type { SearchResult } from '../search/index.ts'
import type { DocumentScope } from '../files/collection-coverage.ts'
import type { ContextReport, CollectionMode } from '../../../shared/context.ts'
import { stepEvent, type ProgressStep } from '../progress.ts'

export const KEEPALIVE_INTERVAL_MS = 15000

export type TurnMessage = { role: 'user' | 'assistant'; content: string }
export type FocusMode = 'flash' | 'balanced' | 'thorough' | 'image'

/** Inputs resolved before the turn starts; runners read these and never the request. */
export interface TurnContext {
  userId: string
  sid: string
  msgs: TurnMessage[]
  /** Indices into `msgs` kept in full when history is trimmed. */
  pinned: ReadonlySet<number>
  models: TurnModels
  focusMode: FocusMode
  spaceId?: string
  /** No web, no image generation, local models only: the space or chat is locked, or the turn reads
   *  a confidential collection or resource (lib/files/confidential.ts), which only a locked turn reads. */
  locked: boolean
  /** May write to the space's memory: false for a locked turn in an unlocked space. Defaults to true. */
  spaceWrites?: boolean
  settings: Record<string, unknown>
  customPrompt?: string
  /** Owned collection ids, sorted. */
  collections: string[]
  /** How the collections are read; `auto` lets the small model choose (collection-mode.ts). Absent: excerpts. */
  collectionMode?: CollectionMode
  includeFileIds?: string[]
  includeMemoryIds?: string[]
  notesFirst?: boolean
  searchCategory?: string
  regenerate?: boolean
  abortSignal: AbortSignal
  /** Set for scheduled monitor runs, which have no client and no RAG over the user's uploaded files. */
  monitor?: {
    /** Pre-fetched RSS items that replace the web pre-search. */
    feedItems?: SearchResult[]
    maxStepsOverride?: number
  }
}

/** What a turn produced, for the caller to cache and persist. */
export interface TurnResult {
  content: string
  /** In the stored shape; index N-1 is the source cited as [N]. */
  sources: unknown[]
  fileSources: unknown[]
  /** False for answers that must not be replayed from the cache (failures, images). */
  cacheable: boolean
  /** The model that wrote the answer, when the mode alone does not say (see answerModelOf). */
  answeredBy?: ModelTarget
}

/** Typed writes onto the turn's event stream. */
export interface TurnSink {
  readonly out: SSEStream
  emit: (event: { type: string; [k: string]: unknown }) => Promise<void>
  step: (step: ProgressStep) => Promise<void>
  /** Sends a context report and remembers it as the turn's latest. */
  context: (report: ContextReport) => Promise<void>
  readonly lastContext: ContextReport | undefined
  /** Asks the user to allow a flagged outbound request; absent means refuse. */
  requestApproval?: (req: EgressApprovalRequest) => Promise<boolean>
}

export function createSink(out: SSEStream, requestApproval?: TurnSink['requestApproval']): TurnSink {
  let lastContext: ContextReport | undefined
  const emit: TurnSink['emit'] = event => out.writeSSE({ data: JSON.stringify(event) })
  return {
    out,
    emit,
    step: step => out.writeSSE({ data: stepEvent(step) }),
    context: report => { lastContext = report; return emit({ type: 'context', ...report }) },
    get lastContext() { return lastContext },
    requestApproval,
  }
}

/** Pings the client while `fn` runs, so an idle-timeout upstream does not reap a silent stream. */
export async function withKeepalive<T>(sink: TurnSink, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => { sink.out.ping().catch(() => {}) }, KEEPALIVE_INTERVAL_MS)
  try {
    return await fn()
  } finally {
    clearInterval(timer)
  }
}

/** Latest user message, the query every relevance decision is made against. */
export const userQueryOf = (msgs: Array<{ role: string; content: string }>) =>
  [...msgs].reverse().find(m => m.role === 'user')?.content ?? ''

/** What Whole collection and Explore read: the picked collections and, in a space chat, the space's
 *  own resources — only those pinned, when any are, as the space's search does. Spaces and
 *  collections tag resources alike, so one id list covers both. */
export const documentSet = (ctx: Pick<TurnContext, 'spaceId' | 'collections' | 'includeFileIds'>): DocumentScope => ctx.spaceId
  ? { ids: [...new Set([ctx.spaceId, ...ctx.collections])], ...(ctx.includeFileIds?.length && { pinned: { spaceId: ctx.spaceId, fileIds: ctx.includeFileIds } }) }
  : { ids: ctx.collections }
