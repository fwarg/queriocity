/** Answer feedback and research traces, collected for users who opt in (`researchFeedback`).
 *
 *  The raw material for later skill evolution (development.md, "Learning from feedback"): a trace
 *  records what a turn searched, found and read; feedback says whether the answer served. Both are
 *  keyed by message id with no foreign key on it, because a retry deletes the answer it replaces
 *  and that answer — with its trace — is the failure worth keeping. The session cascade removes
 *  both with the chat, and so with the user.
 *
 *  Locked turns are never traced: what they read is confidential. */

import { sqlite } from './db.ts'
import { toStoredSource, type TurnSink } from './turn/index.ts'
import type { ProgressStep } from './progress.ts'
import type { SearchResult } from './search/index.ts'
import type { AnswerModel } from '../../shared/llm-catalogue.ts'
import type { FeedbackReason, MessageFeedback } from '../../shared/feedback.ts'

/** Unrated traces older than this are pruned; any feedback signal keeps one indefinitely. */
export const TRACE_RETENTION_DAYS = 30
const DAY_SECONDS = 24 * 60 * 60
const TRACE_VERSION = 1

/** Stream events worth keeping, beside the progress steps; text, thinking and pings are not. */
const KEPT_EVENTS = new Set(['sources', 'file_sources', 'search_warning', 'model_error', 'confidential_excluded'])

export type TraceEntry = { t: number; step: ProgressStep } | { t: number; type: string; [k: string]: unknown }

export interface TraceMeta {
  question: string
  /** Earlier messages in the chat: a follow-up's trace is read differently from a first question. */
  priorMessages: number
  focusMode: string
  collectionMode?: string
  searchCategory?: string
  recipe?: string
}

export interface ResearchTrace extends TraceMeta {
  v: number
  answer: string
  model?: string
  elapsedMs: number
  entries: TraceEntry[]
}

/** Collects one turn's steps and kept events, timed from the start of the turn. */
export class TraceRecorder {
  private readonly t0 = Date.now()
  private readonly entries: TraceEntry[] = []

  constructor(private readonly meta: TraceMeta) {}

  /** The sink the turn writes to, recording on its way through. */
  wrap(sink: TurnSink): TurnSink {
    return {
      out: sink.out,
      emit: event => { this.event(event); return sink.emit(event) },
      step: step => { this.entries.push({ t: this.elapsed(), step }); return sink.step(step) },
      context: report => sink.context(report),
      get lastContext() { return sink.lastContext },
      requestApproval: sink.requestApproval,
    }
  }

  /** The trace with the answer it led to; scripts/research-eval.ts writes this same shape. */
  toTrace(answer: string, model?: AnswerModel): ResearchTrace {
    return { v: TRACE_VERSION, ...this.meta, answer, model: model?.label, elapsedMs: this.elapsed(), entries: this.entries }
  }

  /** The trace as stored: gzipped JSON. */
  serialize(answer: string, model?: AnswerModel): Uint8Array {
    return Bun.gzipSync(JSON.stringify(this.toTrace(answer, model)))
  }

  private elapsed = () => Date.now() - this.t0

  private event(event: { type: string; [k: string]: unknown }) {
    if (!KEPT_EVENTS.has(event.type)) return
    const t = this.elapsed()
    if (event.type === 'sources') this.entries.push({ t, type: 'sources', sources: (event.sources as SearchResult[]).map(toStoredSource) })
    else if (event.type === 'file_sources') this.entries.push({ t, type: 'file_sources', count: (event.sources as unknown[]).length })
    else this.entries.push({ t, ...event })
  }
}

const now = () => Math.floor(Date.now() / 1000)

export function saveTrace(sessionId: string, messageId: string, trace: Uint8Array): void {
  sqlite.run('INSERT OR REPLACE INTO research_traces (message_id, session_id, trace, created_at) VALUES (?, ?, ?, ?)',
    [messageId, sessionId, trace, now()])
}

/** A stored trace, decompressed; null when the turn was not traced. */
export function loadTrace(messageId: string): Record<string, unknown> | null {
  const row = sqlite.query('SELECT trace FROM research_traces WHERE message_id = ?').get(messageId) as { trace: Uint8Array<ArrayBuffer> } | null
  return row ? JSON.parse(new TextDecoder().decode(Bun.gunzipSync(row.trace))) : null
}

/** Records the user's rating, reasons and comment, replacing what they left before. */
export function setFeedback(sessionId: string, messageId: string, { rating, reasons, comment }: MessageFeedback): void {
  sqlite.run(`INSERT INTO message_feedback (message_id, session_id, rating, reasons, comment, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET rating = excluded.rating, reasons = excluded.reasons, comment = excluded.comment, updated_at = excluded.updated_at`,
  [messageId, sessionId, rating, reasons.length ? JSON.stringify(reasons) : null, comment.trim() || null, now()])
  // Withdrawn feedback is no signal: without this the empty row would keep the trace forever.
  sqlite.run(`DELETE FROM message_feedback WHERE message_id = ? AND regenerated = 0
    AND rating IS NULL AND reasons IS NULL AND comment IS NULL`, [messageId])
}

/** Marks an answer the user retried — an implicit 👎. Only for an answer that was traced or rated,
 *  which is how the opt-in reaches here without the caller knowing the user's settings. */
export function markRegenerated(sessionId: string, messageId: string): void {
  sqlite.run(`INSERT INTO message_feedback (message_id, session_id, regenerated, updated_at)
    SELECT ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM research_traces WHERE message_id = ?)
    ON CONFLICT(message_id) DO UPDATE SET regenerated = 1, updated_at = excluded.updated_at`,
  [messageId, sessionId, now(), messageId])
}

/** The explicit feedback on a chat's answers, by message id. */
export function feedbackFor(sessionId: string): Map<string, MessageFeedback> {
  const rows = sqlite.query('SELECT message_id AS id, rating, reasons, comment FROM message_feedback WHERE session_id = ? AND (rating IS NOT NULL OR reasons IS NOT NULL OR comment IS NOT NULL)')
    .all(sessionId) as Array<{ id: string; rating: 1 | -1 | null; reasons: string | null; comment: string | null }>
  return new Map(rows.map(r => [r.id, { rating: r.rating, reasons: r.reasons ? JSON.parse(r.reasons) as FeedbackReason[] : [], comment: r.comment ?? '' }]))
}

/** Removes feedback and traces for messages the user deleted — unlike a retry, a deliberate removal. */
export function deleteFeedback(messageIds: string[]): void {
  const marks = messageIds.map(() => '?').join(', ')
  sqlite.run(`DELETE FROM message_feedback WHERE message_id IN (${marks})`, messageIds)
  sqlite.run(`DELETE FROM research_traces WHERE message_id IN (${marks})`, messageIds)
}

/** Drops traces past retention that carry no signal: no feedback row, and no note saved from the answer. */
export function pruneTraces(at = now()): number {
  return sqlite.run(`DELETE FROM research_traces WHERE created_at < ?
    AND message_id NOT IN (SELECT message_id FROM message_feedback)
    AND message_id NOT IN (SELECT origin_message_id FROM uploaded_files WHERE origin_message_id IS NOT NULL)`,
  [at - TRACE_RETENTION_DAYS * DAY_SECONDS]).changes
}
