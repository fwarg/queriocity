import { useState, useEffect } from 'react'
import { useT, type TFunction } from '../lib/i18n.tsx'
import type { TranslationKey } from '@shared/i18n/index.ts'

/** One entry in the activity log, as built by useChat from the server's `status` events.
 *  Timing is client-side: the server sends no durations, so a slow connection shows the
 *  wall-clock the user actually experienced rather than the server's view of it. */
export interface LogStep {
  kind: string
  text: string
  queries?: string[]
  hosts?: string[]
  count?: number
  index?: number
  total?: number
  detail?: string
  /** A key for one of the closed set of sub-states the server names, translated on arrival.
   *  `detail` stays for the free-form text alongside it. */
  detailKey?: TranslationKey
  startedAt: number
  endedAt?: number
}

/** Re-renders once a second while `active`, so an unfinished step's timer keeps moving.
 *  The whole point is proof of life — a frozen line is indistinguishable from a hung server. */
function useTick(active: boolean) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => force(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

export function Elapsed({ from, to }: { from: number; to?: number }) {
  useTick(to === undefined)
  const ms = (to ?? Date.now()) - from
  // Whole seconds while running (a ticking decimal is noise); one decimal once it is final.
  return <span className="tabular-nums">{to === undefined ? `${Math.floor(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`}</span>
}

/** The step's line in the log.
 *
 *  Built from the structured fields rather than the server's `text`, so it needs no server round
 *  trip to be translated. `detailKey` is the server naming one of a closed set of sub-states;
 *  `detail` is free-form and stays as sent — it carries numbers, not prose (see describeOutcome
 *  in fetch-url.ts). */
function label(step: LogStep, t: TFunction): string {
  const n = step.queries?.length ?? 0
  const detail = step.detailKey ? t(step.detailKey) : step.detail?.replace(/…$/, '')
  switch (step.kind) {
    case 'understand': return t('log.understand')
    case 'read':       return t('log.read', { hosts: step.hosts?.join(', ') ?? '' })
                              + (step.detail ? ` — ${step.detail}` : '')
    case 'search':     return n === 0 ? t('log.searchedWeb')
                            : n > 1 ? t('log.searchedMore', { query: step.queries![0], count: n - 1 })
                            : t('log.searched', { query: step.queries![0] })
    case 'results':    return t('log.results', { count: step.count ?? 0 })
    case 'reason':     return step.total
                            ? t('log.thinkingStep', { index: step.index ?? 0, total: step.total })
                            : t('log.thinking')
    case 'write':      return detail ?? t('log.write')
    case 'memory':     return t('log.memory')
    case 'image':      return detail ?? t('log.image')
    default:           return step.text
  }
}

function StepRow({ step }: { step: LogStep }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const done = step.endedAt !== undefined
  const extra = (step.queries?.length ?? 0) > 1

  return (
    <li className="flex items-baseline gap-2">
      <span className={done ? 'text-gray-600' : 'text-blue-400 animate-pulse'}>{done ? '✓' : '⟳'}</span>
      <span className="flex-1 min-w-0">
        <button
          type="button"
          disabled={!extra}
          onClick={() => setOpen(o => !o)}
          className={`text-left ${extra ? 'hover:text-gray-300 cursor-pointer' : 'cursor-default'}`}
        >
          {label(step, t)}
        </button>
        {open && (
          <span className="block pl-1 text-gray-600">
            {step.queries!.map((q, i) => <span key={i} className="block truncate">&quot;{q}&quot;</span>)}
          </span>
        )}
      </span>
      {/* Pre-search runs before the stream opens and is reported after the fact, so its steps
          land back-to-back and would all read 0.0s. That time is already counted against the
          "Understanding your question" step they happened inside. */}
      {(!done || step.endedAt! - step.startedAt >= 150) && <Elapsed from={step.startedAt} to={step.endedAt} />}
    </li>
  )
}

/** Summary shown once the answer starts. Deliberately not a duration or a source count —
 *  the "Answered in Xs · N search results" line below already carries both. */
function summary(steps: LogStep[], t: TFunction): string {
  const searches = steps.filter(s => s.kind === 'search').length
  const parts = [t('log.steps', { count: steps.length })]
  if (searches) parts.unshift(t('log.searches', { count: searches }))
  return parts.join(', ')
}

/** The activity log: open while the query runs, collapsed to one line once the answer arrives.
 *  Collapsing rather than disappearing keeps the record reachable without holding screen space,
 *  which matters most on a phone. Session-only — a reload drops it. */
export function ProgressLog({ steps, collapsed }: { steps: LogStep[]; collapsed: boolean }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  if (steps.length === 0) return null

  if (collapsed && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="px-4 py-1 text-xs text-gray-600 hover:text-gray-400 text-left"
      >
        ▸ {t('log.researched')} · {summary(steps, t)}
      </button>
    )
  }

  return (
    <div className="px-4 py-1 text-xs text-gray-500">
      {collapsed && (
        <button type="button" onClick={() => setExpanded(false)} className="hover:text-gray-300 mb-0.5">
          ▾ {t('log.researched')} · {summary(steps, t)}
        </button>
      )}
      <ul className="flex flex-col gap-0.5">
        {steps.map((s, i) => <StepRow key={i} step={s} />)}
      </ul>
    </div>
  )
}
