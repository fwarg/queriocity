import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, Play, ChevronDown, ChevronRight } from 'lucide-react'
import {
  fetchMonitors, createMonitor, updateMonitor, deleteMonitor,
  triggerMonitorRun, fetchMonitorRuns, fetchGlobalMonitors,
  subscribeMonitor, unsubscribeMonitor, type Monitor, type MonitorRun, type Space,
} from '../lib/api.ts'
import { MonitorEditor } from './MonitorEditor.tsx'

interface Props {
  spaces: Space[]
  isAdmin: boolean
  timezone?: string
  onOpenSession: (sessionId: string, title: string) => void
}

function formatInterval(minutes: number, preferredHour?: number | null): string {
  const hourSuffix = preferredHour != null ? ` at ${String(preferredHour).padStart(2, '0')}:00` : ''
  if (minutes % 1440 === 0) {
    const d = minutes / 1440
    return (d === 1 ? 'daily' : `every ${d} days`) + hourSuffix
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60
    return h === 1 ? 'every hour' : `every ${h} hours`
  }
  return `every ${minutes} min`
}

function relativeTime(ts: number): string {
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function nextRunLabel(ts: number | undefined): string {
  if (!ts) return 'not scheduled'
  const diff = ts - Date.now() / 1000
  if (diff <= 0) return 'overdue'
  if (diff < 60) return 'in <1 min'
  if (diff < 3600) return `in ${Math.floor(diff / 60)}m`
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`
  return `in ${Math.floor(diff / 86400)}d`
}

interface MonitorCardProps {
  monitor: Monitor
  onEdit: (m: Monitor) => void
  onDelete: (id: string) => void
  onRun: (m: Monitor) => void
  onOpenSession: (sessionId: string, title: string) => void
  isGlobalCard?: boolean
  onUnsubscribe?: (id: string) => void
}

function MonitorCard({ monitor, onEdit, onDelete, onRun, onOpenSession, isGlobalCard, onUnsubscribe }: MonitorCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [runs, setRuns] = useState<MonitorRun[]>([])
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [running, setRunning] = useState(false)

  async function toggleExpand() {
    if (!expanded && runs.length === 0) {
      setLoadingRuns(true)
      fetchMonitorRuns(monitor.id).then(r => { setRuns(r); setLoadingRuns(false) }).catch(() => setLoadingRuns(false))
    }
    setExpanded(v => !v)
  }

  async function handleRun() {
    setRunning(true)
    try {
      await onRun(monitor)
      // Reload runs after successful run
      const updated = await fetchMonitorRuns(monitor.id)
      setRuns(updated)
      setExpanded(true)
    } finally {
      setRunning(false)
    }
  }

  const modeColors: Record<string, string> = {
    flash: 'bg-yellow-700 text-yellow-100',
    balanced: 'bg-blue-700 text-blue-100',
    thorough: 'bg-purple-700 text-purple-100',
  }

  return (
    <div className="rounded-lg bg-gray-800 border border-gray-700 overflow-hidden">
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={toggleExpand}
          className="mt-0.5 text-gray-500 hover:text-gray-300 shrink-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white truncate">{monitor.name}</span>
            <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${modeColors[monitor.focusMode] ?? 'bg-gray-700 text-gray-300'}`}>
              {monitor.focusMode}
            </span>
            {!monitor.enabled && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">paused</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {formatInterval(monitor.intervalMinutes, monitor.preferredHour)}
            {monitor.lastRunAt ? ` · last run ${relativeTime(monitor.lastRunAt)}` : ' · never run'}
            {' · '}next {nextRunLabel(monitor.nextRunAt)}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleRun}
            disabled={running}
            className="p-1.5 rounded text-gray-500 hover:text-green-400 hover:bg-gray-700 disabled:opacity-40 transition-colors"
            aria-label="Run now"
            title="Run now"
          >
            {running ? <span className="text-xs">…</span> : <Play size={12} />}
          </button>
          {!isGlobalCard && (
            <>
              <button
                type="button"
                onClick={() => onEdit(monitor)}
                className="p-1.5 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 transition-colors"
                aria-label="Edit monitor"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(monitor.id)}
                className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-gray-700 transition-colors"
                aria-label="Delete monitor"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
          {isGlobalCard && onUnsubscribe && (
            <button
              type="button"
              onClick={() => onUnsubscribe(monitor.id)}
              className="px-2 py-1 rounded text-xs text-gray-500 hover:text-red-400 hover:bg-gray-700 transition-colors"
              title="Unsubscribe"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-700 px-3 py-2">
          {loadingRuns ? (
            <p className="text-xs text-gray-600 italic">Loading runs…</p>
          ) : runs.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No runs yet. Click ▶ to run now.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {runs.map(r => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onOpenSession(r.sessionId, monitor.name)}
                    className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    {relativeTime(r.runAt)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export function MonitorsView({ spaces, isAdmin, timezone, onOpenSession }: Props) {
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [globalMonitors, setGlobalMonitors] = useState<Monitor[]>([])
  const [editor, setEditor] = useState<'new' | Monitor | null>(null)
  const [globalEditor, setGlobalEditor] = useState<'new' | Monitor | null>(null)
  const [globalExpanded, setGlobalExpanded] = useState(false)
  const [adminExpanded, setAdminExpanded] = useState(false)

  useEffect(() => {
    fetchMonitors().then(setMonitors).catch(() => {})
  }, [])

  useEffect(() => {
    if (globalExpanded && globalMonitors.length === 0) {
      fetchGlobalMonitors().then(setGlobalMonitors).catch(() => {})
    }
  }, [globalExpanded])

  async function handleSave(data: Parameters<typeof createMonitor>[0]) {
    if (editor === 'new') {
      const created = await createMonitor(data)
      setMonitors(prev => [created, ...prev])
    } else if (editor) {
      await updateMonitor((editor as Monitor).id, data)
      setMonitors(prev => prev.map(m => m.id === (editor as Monitor).id ? { ...m, ...data } : m))
    }
    setEditor(null)
  }

  async function handleGlobalSave(data: Parameters<typeof createMonitor>[0]) {
    const { createGlobalMonitor, updateGlobalMonitor } = await import('../lib/api.ts')
    if (globalEditor === 'new') {
      const created = await createGlobalMonitor({ ...data, isGlobal: true } as Parameters<typeof createGlobalMonitor>[0])
      setGlobalMonitors(prev => [created, ...prev])
    } else if (globalEditor) {
      await updateGlobalMonitor((globalEditor as Monitor).id, data)
      setGlobalMonitors(prev => prev.map(m => m.id === (globalEditor as Monitor).id ? { ...m, ...data } : m))
    }
    setGlobalEditor(null)
  }

  async function handleDelete(id: string) {
    await deleteMonitor(id)
    setMonitors(prev => prev.filter(m => m.id !== id))
  }

  async function handleGlobalDelete(id: string) {
    const { deleteGlobalMonitor } = await import('../lib/api.ts')
    await deleteGlobalMonitor(id)
    setGlobalMonitors(prev => prev.filter(m => m.id !== id))
  }

  async function handleRun(monitor: Monitor) {
    await triggerMonitorRun(monitor.id)
    setMonitors(prev => prev.map(m => m.id === monitor.id ? { ...m, lastRunAt: Math.floor(Date.now() / 1000) } : m))
  }

  async function handleSubscribe(id: string) {
    await subscribeMonitor(id)
    const sub = globalMonitors.find(m => m.id === id)
    if (sub) setMonitors(prev => [...prev, { ...sub, subscribed: true }])
  }

  async function handleUnsubscribe(id: string) {
    await unsubscribeMonitor(id)
    setMonitors(prev => prev.filter(m => m.id !== id))
  }

  const subscribedIds = new Set(monitors.filter(m => m.subscribed).map(m => m.id))
  const ownMonitors = monitors.filter(m => !m.subscribed)
  const subscribedMonitors = monitors.filter(m => m.subscribed)

  return (
    <div className="flex-1 overflow-y-auto p-4 max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-100">Monitors</h2>
        <button
          type="button"
          onClick={() => setEditor('new')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium transition-colors"
        >
          <Plus size={14} />
          New monitor
        </button>
      </div>

      {ownMonitors.length === 0 && subscribedMonitors.length === 0 ? (
        <p className="text-sm text-gray-500 italic">
          No monitors yet. Create one to run a query automatically on a schedule.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {ownMonitors.map(m => (
            <MonitorCard
              key={m.id}
              monitor={m}
              onEdit={setEditor}
              onDelete={handleDelete}
              onRun={handleRun}
              onOpenSession={onOpenSession}
            />
          ))}

          {subscribedMonitors.length > 0 && (
            <>
              <p className="text-xs text-gray-500 mt-2 px-1">Subscribed</p>
              {subscribedMonitors.map(m => (
                <MonitorCard
                  key={m.id}
                  monitor={m}
                  onEdit={setEditor}
                  onDelete={() => {}}
                  onRun={handleRun}
                  onOpenSession={onOpenSession}
                  isGlobalCard
                  onUnsubscribe={handleUnsubscribe}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Global monitors browse section */}
      <div className="mt-6">
        <button
          type="button"
          onClick={() => setGlobalExpanded(v => !v)}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {globalExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Browse global monitors
        </button>

        {globalExpanded && (
          <div className="mt-2 flex flex-col gap-2">
            {globalMonitors.length === 0 ? (
              <p className="text-xs text-gray-600 italic">No global monitors available.</p>
            ) : (
              globalMonitors.map(m => {
                const alreadySubscribed = subscribedIds.has(m.id)
                return (
                  <div key={m.id} className="flex items-center gap-2 p-2.5 rounded bg-gray-800 border border-gray-700">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">{m.name}</div>
                      <div className="text-xs text-gray-500">{formatInterval(m.intervalMinutes, m.preferredHour)}</div>
                    </div>
                    {alreadySubscribed ? (
                      <span className="text-xs text-gray-500">Subscribed</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSubscribe(m.id)}
                        className="px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-xs text-white transition-colors"
                      >
                        Subscribe
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Admin global monitor management */}
      {isAdmin && (
        <div className="mt-4 border-t border-gray-800 pt-4">
          <button
            type="button"
            onClick={() => setAdminExpanded(v => !v)}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {adminExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Manage global monitors (admin)
          </button>

          {adminExpanded && (
            <div className="mt-2 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setGlobalEditor('new')}
                className="self-start flex items-center gap-1.5 px-2.5 py-1 rounded border border-dashed border-gray-600 text-xs text-gray-500 hover:text-gray-300 hover:border-gray-400 transition-colors"
              >
                <Plus size={12} />
                New global monitor
              </button>
              {globalMonitors.map(m => (
                <div key={m.id} className="flex items-center gap-2 p-2.5 rounded bg-gray-800 border border-gray-700">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{m.name}</div>
                    <div className="text-xs text-gray-500">{formatInterval(m.intervalMinutes)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGlobalEditor(m)}
                    className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 transition-colors"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGlobalDelete(m.id)}
                    className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-700 transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {editor !== null && (
        <MonitorEditor
          initial={editor === 'new' ? undefined : editor as Monitor}
          spaces={spaces}
          timezone={timezone}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}

      {globalEditor !== null && (
        <MonitorEditor
          initial={globalEditor === 'new' ? undefined : globalEditor as Monitor}
          spaces={[]}
          onSave={handleGlobalSave}
          onClose={() => setGlobalEditor(null)}
          isGlobal
        />
      )}
    </div>
  )
}
