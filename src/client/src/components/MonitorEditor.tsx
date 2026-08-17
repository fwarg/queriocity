import { useState, useEffect } from 'react'
import { useT } from '../lib/i18n.tsx'
import type { TranslationKey } from '@shared/i18n/index.ts'
import { Modal } from './Modal.tsx'
import { fetchFeeds, type Monitor, type Space, type FeedRegion } from '../lib/api.ts'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  initial?: Monitor
  spaces: Space[]
  timezone?: string
  onSave: (data: Omit<Monitor, 'id' | 'createdAt' | 'isGlobal' | 'subscribed'> & { timezone?: string | null }) => Promise<void>
  onClose: () => void
  isGlobal?: boolean
}

const INTERVAL_PRESETS: Array<{ labelKey: TranslationKey; minutes: number }> = [
  { labelKey: 'monitorEdit.preset1h', minutes: 60 },
  { labelKey: 'monitorEdit.preset6h', minutes: 360 },
  { labelKey: 'monitorEdit.presetDaily', minutes: 1440 },
  { labelKey: 'monitorEdit.presetWeekly', minutes: 10080 },
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
  const t = useT()
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
  const [monitorTimezone, setMonitorTimezone] = useState<string>(initial?.timezone ?? '')
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
        timezone: isGlobal ? (monitorTimezone.trim() || null) : undefined,
        spaceId: spaceId || null,
        enabled,
        feedSources: feedSources.length > 0 ? feedSources : null,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('studio.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const title = isGlobal
    ? t(initial ? 'monitorEdit.editGlobal' : 'monitorEdit.newGlobal')
    : t(initial ? 'monitor.edit' : 'monitor.new')

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
          {t('monitorEdit.tabGeneral')}
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
          {t('monitorEdit.tabSources')}{feedSources.length > 0 ? ` (${feedSources.length})` : ''}
        </button>
      </div>

      <div className="flex flex-col gap-4">

        {tab === 'general' && (
          <>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('monitorEdit.name')} <span className="text-blue-400">*</span></label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={100}
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                placeholder={t('monitorEdit.namePlaceholder')}
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">
                {t('monitorEdit.prompt')} <span className="text-blue-400">*</span>
                {feedSources.length > 0 && (
                  <span className="ml-2 text-gray-500">{t('monitorEdit.promptFeedsNote')}</span>
                )}
              </label>
              <textarea
                value={promptText}
                onChange={e => setPromptText(e.target.value)}
                rows={4}
                className="w-full rounded bg-gray-800 border border-gray-700 px-2.5 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 resize-y font-mono"
                placeholder={t(feedSources.length > 0 ? 'monitorEdit.promptFeedsPlaceholder' : 'monitorEdit.promptPlaceholder')}
              />
              {feedSources.length > 0 && promptText === '' && (
                <button
                  type="button"
                  onClick={() => setPromptText(t('monitorEdit.promptFeedsPlaceholder'))}
                  className="text-xs text-blue-400 hover:text-blue-300 text-left"
                >
                  ↑ {t('monitorEdit.useSuggested')}
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('monitorEdit.mode')}</label>
                <select
                  value={focusMode}
                  onChange={e => setFocusMode(e.target.value as 'flash' | 'balanced' | 'thorough')}
                  className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="flash">{t('mode.flash')}</option>
                  <option value="balanced">{t('mode.balanced')}</option>
                  <option value="thorough">{t('mode.thorough')}</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('monitorEdit.keepLast')}</label>
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
              <label className="block text-xs text-gray-400 mb-1">{t('monitorEdit.interval')}</label>
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
                    {t(p.labelKey)}
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
                  <option value="hours">{t('monitorEdit.unitHours')}</option>
                  <option value="days">{t('monitorEdit.unitDays')}</option>
                </select>
              </div>
            </div>

            {showHourPicker && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('monitorEdit.runAt')}</label>
                <div className="flex items-center gap-2">
                  <select
                    value={preferredHour ?? ''}
                    onChange={e => setPreferredHour(e.target.value === '' ? null : parseInt(e.target.value))}
                    className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                  >
                    <option value="">{t('monitorEdit.anyTime')}</option>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                  {isGlobal ? (
                    <input
                      type="text"
                      value={monitorTimezone}
                      onChange={e => setMonitorTimezone(e.target.value)}
                      placeholder={t('monitorEdit.timezonePlaceholder')}
                      className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500 w-44"
                    />
                  ) : (
                    <span className="text-xs text-gray-500">{timezone || t('monitorEdit.serverTime')}</span>
                  )}
                </div>
              </div>
            )}

            {!isGlobal && spaces.some(s => s.kind === 'space') && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('monitorEdit.spaceContext')}</label>
                <select
                  value={spaceId}
                  onChange={e => setSpaceId(e.target.value)}
                  className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="">{t('monitorEdit.spaceNone')}</option>
                  {/* A monitor writes its runs into the space as chats, which a collection has no room for. */}
                  {spaces.filter(s => s.kind === 'space').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
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
              <span className="text-sm text-gray-300">{t('monitorEdit.enabled')}</span>
            </label>
          </>
        )}

        {tab === 'sources' && (
          <div>
            <p className="text-xs text-gray-500 mb-3">
              {t('monitorEdit.sourcesIntro')}
              {feedSources.length > 0 && <span className="ml-1 text-blue-400">{t('monitorEdit.sourcesSelected', { count: feedSources.length })}</span>}
            </p>

            {catalogLoading && <p className="text-sm text-gray-500">{t('monitorEdit.loadingSources')}</p>}

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
                      {t(allSelected ? 'monitorEdit.selectNone' : 'monitorEdit.selectAll')}
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
          {saving ? t('common.saving') : t(initial ? 'monitorEdit.update' : 'monitorEdit.save')}
        </button>
      </div>
    </Modal>
  )
}
