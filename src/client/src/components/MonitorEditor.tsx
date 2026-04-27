import { useState, useEffect } from 'react'
import { Modal } from './Modal.tsx'
import { fetchFeeds, type Monitor, type Space, type FeedRegion } from '../lib/api.ts'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  initial?: Monitor
  spaces: Space[]
  timezone?: string
  onSave: (data: Omit<Monitor, 'id' | 'createdAt' | 'isGlobal' | 'subscribed'>) => Promise<void>
  onClose: () => void
  isGlobal?: boolean
}

const INTERVAL_PRESETS = [
  { label: '1 hour', minutes: 60 },
  { label: '6 hours', minutes: 360 },
  { label: 'Daily', minutes: 1440 },
  { label: 'Weekly', minutes: 10080 },
]

function minutesToUnit(minutes: number): { value: number; unit: 'hours' | 'days' } {
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' }
  return { value: minutes / 60, unit: 'hours' }
}

function typeColor(type: string): string {
  if (type.startsWith('Wire Service') || type.includes('News Agency')) return 'bg-blue-900 text-blue-300'
  if (type.startsWith('Public Broadcaster') || type.startsWith('Public Radio')) return 'bg-green-900 text-green-300'
  if (type.startsWith('State Broadcaster') || type.startsWith('State News')) return 'bg-rose-900 text-rose-300'
  if (type.startsWith('Newspaper')) return 'bg-gray-700 text-gray-300'
  if (type.includes('Financial')) return 'bg-yellow-900 text-yellow-300'
  if (type.startsWith('Peer-Reviewed')) return 'bg-emerald-900 text-emerald-300'
  if (type.startsWith('Magazine')) return 'bg-indigo-900 text-indigo-300'
  if (type.startsWith('Broadcast') || type.startsWith('Online') || type.startsWith('News Magazine') || type.startsWith('News Aggregator')) return 'bg-purple-900 text-purple-300'
  return 'bg-gray-800 text-gray-400'
}

export function MonitorEditor({ initial, spaces, timezone, onSave, onClose, isGlobal }: Props) {
  const [tab, setTab] = useState<'general' | 'sources'>('general')
  const [name, setName] = useState(initial?.name ?? '')
  const [promptText, setPromptText] = useState(initial?.promptText ?? '')
  const [focusMode, setFocusMode] = useState<'flash' | 'balanced' | 'thorough'>(
    (initial?.focusMode as 'flash' | 'balanced' | 'thorough') ?? 'balanced'
  )
  const initInterval = minutesToUnit(initial?.intervalMinutes ?? 1440)
  const [intervalValue, setIntervalValue] = useState(String(initInterval.value))
  const [intervalUnit, setIntervalUnit] = useState<'hours' | 'days'>(initInterval.unit)
  const [keepCount, setKeepCount] = useState(String(initial?.keepCount ?? 3))
  const [spaceId, setSpaceId] = useState<string>(initial?.spaceId ?? '')
  const [preferredHour, setPreferredHour] = useState<number | null>(initial?.preferredHour ?? null)
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [feedSources, setFeedSources] = useState<string[]>(initial?.feedSources ?? [])
  const [catalog, setCatalog] = useState<FeedRegion[] | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [expandedRegions, setExpandedRegions] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const intervalMinutes = Math.max(60, (parseInt(intervalValue) || 1) * (intervalUnit === 'days' ? 1440 : 60))
  const showHourPicker = intervalMinutes >= 1440
  const canSave = name.trim().length > 0 && promptText.trim().length > 0 && !saving

  useEffect(() => {
    if (tab === 'sources' && !catalog && !catalogLoading) {
      setCatalogLoading(true)
      fetchFeeds()
        .then(data => { setCatalog(data); setExpandedRegions(new Set([data[0]?.region ?? ''])) })
        .catch(() => {})
        .finally(() => setCatalogLoading(false))
    }
  }, [tab, catalog, catalogLoading])

  function applyPreset(minutes: number) {
    const { value, unit } = minutesToUnit(minutes)
    setIntervalValue(String(value))
    setIntervalUnit(unit)
  }

  function toggleSource(name: string) {
    setFeedSources(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )
  }

  function toggleRegion(region: string) {
    setExpandedRegions(prev => {
      const next = new Set(prev)
      if (next.has(region)) next.delete(region)
      else next.add(region)
      return next
    })
  }

  function selectAllInRegion(region: FeedRegion, select: boolean) {
    const names = region.sources.map(s => s.name)
    setFeedSources(prev =>
      select ? [...new Set([...prev, ...names])] : prev.filter(n => !names.includes(n))
    )
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      await onSave({
        name: name.trim(),
        promptText,
        focusMode,
        intervalMinutes,
        keepCount: Math.max(1, Math.min(20, parseInt(keepCount) || 3)),
        preferredHour: showHourPicker ? preferredHour : null,
        spaceId: spaceId || null,
        enabled,
        feedSources: feedSources.length > 0 ? feedSources : null,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const title = isGlobal
    ? (initial ? 'Edit global monitor' : 'New global monitor')
    : (initial ? 'Edit monitor' : 'New monitor')

  return (
    <Modal title={title} onClose={onClose}>
      {/* Tab bar */}
      <div className="flex border-b border-gray-700 mb-4 -mt-1">
        <button
          type="button"
          onClick={() => setTab('general')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'general'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          General
        </button>
        <button
          type="button"
          onClick={() => setTab('sources')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'sources'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          News sources{feedSources.length > 0 ? ` (${feedSources.length})` : ''}
        </button>
      </div>

      <div className="flex flex-col gap-4">

        {tab === 'general' && (
          <>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name <span className="text-blue-400">*</span></label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={100}
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                placeholder="e.g. Daily tech news"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Prompt <span className="text-blue-400">*</span>
                {feedSources.length > 0 && (
                  <span className="ml-2 text-gray-500">(feeds injected automatically — focus on synthesis instructions)</span>
                )}
              </label>
              <textarea
                value={promptText}
                onChange={e => setPromptText(e.target.value)}
                rows={4}
                className="w-full rounded bg-gray-800 border border-gray-700 px-2.5 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 resize-y font-mono"
                placeholder={feedSources.length > 0
                  ? 'Summarise the most important stories from my selected news sources. Group by topic. Note the source type and region for each story.'
                  : 'Summarise the latest news in AI and machine learning.'}
              />
              {feedSources.length > 0 && promptText === '' && (
                <button
                  type="button"
                  onClick={() => setPromptText('Summarise the most important stories from my selected news sources. Group by topic. Note the source type and region for each story.')}
                  className="text-xs text-blue-400 hover:text-blue-300 text-left"
                >
                  ↑ Use suggested prompt
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Mode</label>
                <select
                  value={focusMode}
                  onChange={e => setFocusMode(e.target.value as 'flash' | 'balanced' | 'thorough')}
                  className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="flash">Flash</option>
                  <option value="balanced">Balanced</option>
                  <option value="thorough">Thorough</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Keep last</label>
                <input
                  type="number"
                  value={keepCount}
                  onChange={e => setKeepCount(e.target.value)}
                  min={1}
                  max={20}
                  className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">Interval</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {INTERVAL_PRESETS.map(p => (
                  <button
                    key={p.minutes}
                    type="button"
                    onClick={() => applyPreset(p.minutes)}
                    className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${
                      intervalMinutes === p.minutes
                        ? 'bg-blue-700 border-blue-600 text-white'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={intervalValue}
                  onChange={e => setIntervalValue(e.target.value)}
                  min={1}
                  className="w-20 rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
                <select
                  value={intervalUnit}
                  onChange={e => setIntervalUnit(e.target.value as 'hours' | 'days')}
                  className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
            </div>

            {showHourPicker && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Run at</label>
                <div className="flex items-center gap-2">
                  <select
                    value={preferredHour ?? ''}
                    onChange={e => setPreferredHour(e.target.value === '' ? null : parseInt(e.target.value))}
                    className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Any time</option>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                  <span className="text-xs text-gray-500">{timezone || 'server time'}</span>
                </div>
              </div>
            )}

            {!isGlobal && spaces.length > 0 && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Space context (optional)</label>
                <select
                  value={spaceId}
                  onChange={e => setSpaceId(e.target.value)}
                  className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="">None</option>
                  {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={enabled}
                onChange={e => setEnabled(e.target.checked)}
                className="rounded accent-blue-500"
              />
              <span className="text-sm text-gray-300">Enabled</span>
            </label>
          </>
        )}

        {tab === 'sources' && (
          <div>
            <p className="text-xs text-gray-500 mb-3">
              Selected feeds are fetched at run time and injected as context. The AI synthesises
              from those articles rather than doing a general web search.
              {feedSources.length > 0 && <span className="ml-1 text-blue-400">{feedSources.length} selected.</span>}
            </p>

            {catalogLoading && <p className="text-sm text-gray-500">Loading sources…</p>}

            {catalog && catalog.map(region => {
              const expanded = expandedRegions.has(region.region)
              const selectedInRegion = region.sources.filter(s => feedSources.includes(s.name)).length
              const allSelected = selectedInRegion === region.sources.length

              return (
                <div key={region.region} className="border border-gray-700 rounded mb-2">
                  <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-800 rounded-t"
                    onClick={() => toggleRegion(region.region)}>
                    {expanded ? <ChevronDown size={13} className="shrink-0 text-gray-500" /> : <ChevronRight size={13} className="shrink-0 text-gray-500" />}
                    <span className="text-sm font-medium text-gray-300 flex-1">{region.region}</span>
                    {selectedInRegion > 0 && (
                      <span className="text-xs text-blue-400">{selectedInRegion}/{region.sources.length}</span>
                    )}
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); selectAllInRegion(region, !allSelected) }}
                      className="text-xs text-gray-500 hover:text-gray-300 px-1"
                    >
                      {allSelected ? 'none' : 'all'}
                    </button>
                  </div>

                  {expanded && (
                    <div className="border-t border-gray-700 divide-y divide-gray-800">
                      {region.sources.map(source => (
                        <label key={source.name} className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-800/50">
                          <input
                            type="checkbox"
                            checked={feedSources.includes(source.name)}
                            onChange={() => toggleSource(source.name)}
                            className="mt-0.5 shrink-0 accent-blue-500"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm text-gray-200">{source.name}</span>
                              <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${typeColor(source.type)}`}>
                                {source.type}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">{source.country} · {source.topic} · {source.ownership}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="self-start px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm font-medium transition-colors"
        >
          {saving ? 'Saving…' : initial ? 'Update monitor' : 'Save monitor'}
        </button>
      </div>
    </Modal>
  )
}
