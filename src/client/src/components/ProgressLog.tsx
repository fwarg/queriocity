import { useState, useEffect } from 'react'

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

function label(step: LogStep): string {
  const n = step.queries?.length ?? 0
  switch (step.kind) {
    case 'understand': return 'Understanding your question'
    case 'read':       return `Read ${step.hosts?.join(', ') ?? ''}${step.detail ? ` — ${step.detail}` : ''}`
    case 'search':     return n === 0 ? 'Searched the web'
                            : n > 1 ? `Searched "${step.queries![0]}" +${n - 1} more`
                            : `Searched "${step.queries![0]}"`
    case 'results':    return `Found ${step.count} result${step.count === 1 ? '' : 's'}`
    case 'reason':     return step.total ? `Thinking · step ${step.index} of ${step.total}` : 'Thinking'
    case 'write':      return step.detail ? step.detail.replace(/…$/, '') : 'Writing answer'
    case 'memory':     return 'Saved to memory'
    case 'image':      return step.detail ? step.detail.replace(/…$/, '') : 'Generating image'
    default:           return step.text
  }
}

function StepRow({ step }: { step: LogStep }) {
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
          {label(step)}
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
function summary(steps: LogStep[]): string {
  const searches = steps.filter(s => s.kind === 'search').length
  const parts = [`${steps.length} step${steps.length === 1 ? '' : 's'}`]
  if (searches) parts.unshift(`${searches} search${searches === 1 ? '' : 'es'}`)
  return parts.join(', ')
}

/** The activity log: open while the query runs, collapsed to one line once the answer arrives.
 *  Collapsing rather than disappearing keeps the record reachable without holding screen space,
 *  which matters most on a phone. Session-only — a reload drops it. */
export function ProgressLog({ steps, collapsed }: { steps: LogStep[]; collapsed: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (steps.length === 0) return null

  if (collapsed && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="px-4 py-1 text-xs text-gray-600 hover:text-gray-400 text-left"
      >
        ▸ Researched · {summary(steps)}
      </button>
    )
  }

  return (
    <div className="px-4 py-1 text-xs text-gray-500">
      {collapsed && (
        <button type="button" onClick={() => setExpanded(false)} className="hover:text-gray-300 mb-0.5">
          ▾ Researched · {summary(steps)}
        </button>
      )}
      <ul className="flex flex-col gap-0.5">
        {steps.map((s, i) => <StepRow key={i} step={s} />)}
      </ul>
    </div>
  )
}
