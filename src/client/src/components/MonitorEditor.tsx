import { useState } from 'react'
import { Modal } from './Modal.tsx'
import type { Monitor, Space } from '../lib/api.ts'

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

export function MonitorEditor({ initial, spaces, timezone, onSave, onClose, isGlobal }: Props) {
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const intervalMinutes = Math.max(60, (parseInt(intervalValue) || 1) * (intervalUnit === 'days' ? 1440 : 60))
  const showHourPicker = intervalMinutes >= 1440
  const canSave = name.trim().length > 0 && promptText.trim().length > 0 && !saving

  function applyPreset(minutes: number) {
    const { value, unit } = minutesToUnit(minutes)
    setIntervalValue(String(value))
    setIntervalUnit(unit)
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
      <div className="flex flex-col gap-4">

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
          <label className="block text-xs text-gray-400 mb-1">Prompt <span className="text-blue-400">*</span></label>
          <textarea
            value={promptText}
            onChange={e => setPromptText(e.target.value)}
            rows={4}
            className="w-full rounded bg-gray-800 border border-gray-700 px-2.5 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 resize-y font-mono"
            placeholder="Summarise the latest news in AI and machine learning."
          />
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
