import { useState } from 'react'
import { Pin } from 'lucide-react'
import type { ContextReport } from '@shared/context.ts'
import { useT } from '../lib/i18n.tsx'

const kChars = (n: number) => `${(n / 1000).toFixed(1)}k`

/** Pins a message so it is kept in full when the conversation outgrows the model's context. */
export function PinButton({ pinned, keptInFull, onToggle, onBlue }: { pinned?: boolean; keptInFull?: boolean; onToggle: () => void; onBlue?: boolean }) {
  const t = useT()
  const tone = onBlue
    ? (pinned ? 'text-amber-300 hover:text-amber-200' : 'text-blue-300 hover:text-white opacity-60 hover:opacity-100')
    : (pinned ? 'text-amber-400 hover:text-amber-300' : 'text-gray-600 hover:text-gray-400')
  return (
    <button
      onClick={onToggle}
      aria-pressed={!!pinned}
      title={t(pinned ? 'pin.unpin' : 'pin.pin')}
      className={`flex items-center gap-1 p-1 -m-0.5 rounded text-[11px] transition-colors ${tone}`}
    >
      <Pin size={13} className={pinned ? 'fill-current' : ''} />
      {pinned && keptInFull && <span>{t('pin.keptInFull')}</span>}
    </button>
  )
}

/** Marks where the model's view of the conversation begins: above it, unpinned messages were
 *  either summarised (with the summary one tap away) or not seen at all. */
export function ContextDivider({ kind, count, summary }: { kind: 'lost' | 'summarised'; count: number; summary?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-center gap-2 py-1 text-[11px] text-gray-500">
      <div className="flex items-center gap-2 w-full">
        <div className="flex-1 border-t border-dashed border-gray-700" />
        <span className="text-center">{t(kind === 'lost' ? 'context.lost' : 'context.summarised', { count })}</span>
        {summary && (
          <button onClick={() => setOpen(o => !o)} className="px-1.5 py-0.5 rounded text-blue-400 hover:text-blue-300">
            {t(open ? 'context.hideSummary' : 'context.showSummary')}
          </button>
        )}
        <div className="flex-1 border-t border-dashed border-gray-700" />
      </div>
      {open && summary && (
        <div className="w-full max-w-2xl whitespace-pre-wrap rounded border border-gray-700 bg-gray-900 p-3 text-xs text-gray-400">{summary}</div>
      )}
    </div>
  )
}

/** How the context was spent on the latest turn, as a stacked bar; tapping it lists the parts —
 *  a tooltip would be unreachable on a phone. */
export function ContextMeter({ report }: { report: ContextReport }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const budget = Math.max(report.budgetChars, 1)
  const parts = [
    { key: 'context.system', chars: report.systemChars, color: 'bg-gray-500' },
    { key: 'context.pinned', chars: report.pinnedChars, color: 'bg-amber-400' },
    { key: 'context.summary', chars: report.summaryChars, color: 'bg-purple-400' },
    { key: 'context.recent', chars: report.historyChars, color: 'bg-blue-400' },
    { key: 'context.search', chars: report.searchChars ?? 0, color: 'bg-emerald-400' },
  ] as const
  const used = parts.reduce((sum, p) => sum + p.chars, 0)
  const pct = Math.min(100, Math.round((used / budget) * 100))
  const warn = pct >= 80 || report.cut > 0
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        onBlur={() => setOpen(false)}
        className="flex items-center gap-1.5 px-1 py-1 text-xs"
        aria-expanded={open}
      >
        <span className="flex h-1.5 w-16 overflow-hidden rounded-full bg-gray-800">
          {parts.map(p => <span key={p.key} className={p.color} style={{ width: `${(p.chars / budget) * 100}%` }} />)}
        </span>
        <span className={warn ? 'text-amber-400' : 'text-gray-600'}>{t('context.meter', { pct })}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-10 w-64 rounded border border-gray-700 bg-gray-800 p-3 text-xs text-gray-300 shadow-lg flex flex-col gap-1">
          <p className="text-gray-500">{t('context.unit')}</p>
          {parts.filter(p => p.chars > 0).map(p => (
            <div key={p.key} className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${p.color}`} />
              <span className="flex-1">{t(p.key)}</span>
              <span className="text-gray-500">{kChars(p.chars)}</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-gray-700" />
            <span className="flex-1">{t('context.free')}</span>
            <span className="text-gray-500">{kChars(Math.max(0, budget - used))}</span>
          </div>
          {report.pinnedTruncated && <p className="mt-1 text-amber-400">{t('context.pinnedTruncated')}</p>}
          {report.cut > 0 && !report.summary && <p className="mt-1 text-gray-500">{t('context.compressHint')}</p>}
        </div>
      )}
    </div>
  )
}
