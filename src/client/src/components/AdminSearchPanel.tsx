import { useState, useEffect } from 'react'
import { useConfirm } from './confirm.tsx'
import {
  fetchSearchPolicy, saveSearchPolicy, resetSearchPolicy,
  type SearchPolicy, type SearchProviderPolicy, type SearchProviderInfo, type SearchProviderStats,
} from '../lib/api.ts'

const INPUT = 'px-2 py-1 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500'
const LABEL = 'flex flex-col gap-1 text-xs text-gray-400'

/** "google=1, brave=0.8" ⇄ { google: 1, brave: 0.8 }; malformed entries are dropped. */
const formatWeights = (w: Record<string, number>) => Object.entries(w).map(([e, n]) => `${e}=${n}`).join(', ')
function parseWeights(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of text.split(',')) {
    const [name, value] = part.split('=').map(s => s.trim())
    const n = Number(value)
    if (name && value && Number.isFinite(n)) out[name.toLowerCase()] = n
  }
  return out
}

function StatsLine({ stats }: { stats?: SearchProviderStats }) {
  if (!stats?.calls) return <p className="text-xs text-gray-600">No searches since server start.</p>
  const topEngines = Object.entries(stats.engines).sort((a, b) => b[1] - a[1]).slice(0, 8)
  return (
    <div className="text-xs text-gray-500 flex flex-col gap-0.5">
      <p>
        {stats.calls} calls · {stats.failures} failed · avg {Math.round(stats.totalMs / stats.calls)} ms ·{' '}
        {stats.results} hits, {stats.kept} kept after fusion ({stats.results ? Math.round(100 * stats.kept / stats.results) : 0}%)
        {stats.quotaSkips > 0 && <> · <span className="text-amber-400">{stats.quotaSkips} skipped over quota</span></>}
      </p>
      {topEngines.length > 0 && <p>Engines: {topEngines.map(([e, n]) => `${e} ${n}`).join(' · ')}</p>}
    </div>
  )
}

interface CardProps {
  info: SearchProviderInfo
  policy: SearchProviderPolicy
  stats?: SearchProviderStats
  /** Calls this UTC month. */
  used: number
  engineDraft: string
  onChange: (p: SearchProviderPolicy) => void
  onEngineDraft: (text: string) => void
}

function ProviderCard({ info, policy, stats, used, engineDraft, onChange, onEngineDraft }: CardProps) {
  const nearQuota = policy.monthlyQuota > 0 && used >= 0.8 * policy.monthlyQuota
  const set = <K extends keyof SearchProviderPolicy>(k: K, v: SearchProviderPolicy[K]) => onChange({ ...policy, [k]: v })
  return (
    <div className="flex flex-col gap-3 border border-gray-800 rounded p-3">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={policy.enabled} onChange={e => set('enabled', e.target.checked)} className="accent-blue-500 w-3.5 h-3.5" />
          <span className="text-sm font-medium text-gray-200">{info.label}</span>
          <span className="text-xs text-gray-500">{info.kind}</span>
        </label>
        <span className={`text-xs ${info.configured ? 'text-green-400' : 'text-amber-400'}`}>
          {info.configured ? 'configured' : `not configured — set ${info.envVars.join(', ')}`}
        </span>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className={LABEL}>Role
          <select value={policy.role} onChange={e => set('role', e.target.value as SearchProviderPolicy['role'])} className={INPUT}>
            <option value="primary">Primary</option>
            <option value="supplement">Supplement</option>
            <option value="fallback">Fallback</option>
          </select>
        </label>
        <label className={LABEL}>Weight
          <input type="number" min={0} max={10} step={0.1} value={policy.weight} onChange={e => set('weight', Number(e.target.value))} className={`${INPUT} w-20`} />
        </label>
        <label className={LABEL}>Reserved slots
          <input type="number" min={0} max={50} value={policy.minSlots} onChange={e => set('minSlots', Number(e.target.value))} className={`${INPUT} w-20`} />
        </label>
        <label className={LABEL}>Monthly quota (0 = unlimited)
          <input type="number" min={0} step={100} value={policy.monthlyQuota} onChange={e => set('monthlyQuota', Number(e.target.value))} className={`${INPUT} w-24`} />
          <span className={nearQuota ? 'text-amber-400' : 'text-gray-500'}>
            used this month: {used}{policy.monthlyQuota > 0 ? ` / ${policy.monthlyQuota}` : ''}
          </span>
        </label>
      </div>
      {info.kind === 'meta' && (
        <div className="flex flex-wrap gap-4">
          <label className={`${LABEL} flex-1 min-w-48`}>Engine weights (engine=weight, …; ≥ 1 counts as major)
            <input type="text" value={engineDraft} onChange={e => onEngineDraft(e.target.value)} placeholder="duckduckgo=1, brave=1, marginalia=0.4" className={INPUT} />
          </label>
          <label className={LABEL}>Other engines
            <input type="number" min={0} max={10} step={0.1} value={policy.defaultEngineWeight} onChange={e => set('defaultEngineWeight', Number(e.target.value))} className={`${INPUT} w-20`} />
          </label>
        </div>
      )}
      <label className="flex items-start gap-2 cursor-pointer w-fit">
        <input type="checkbox" checked={policy.trustedForLocked} onChange={e => set('trustedForLocked', e.target.checked)} className="accent-blue-500 w-3.5 h-3.5 mt-0.5" />
        <span className="text-xs text-gray-400">
          Trusted for locked spaces
          {policy.trustedForLocked && <span className="text-amber-400"> — this provider receives locked-space queries. Only for services you host yourself.</span>}
        </span>
      </label>
      <StatsLine stats={stats} />
    </div>
  )
}

function FusionSettings({ policy, onChange }: { policy: SearchPolicy; onChange: (p: SearchPolicy) => void }) {
  const set = <K extends keyof SearchPolicy>(k: K, v: SearchPolicy[K]) => onChange({ ...policy, [k]: v })
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Merging & limits</p>
      <p className="text-xs text-gray-500">
        Legacy: primaries in order, a fallback when they come back thin, supplements interleaved in their reserved slots.
        Rank fusion: every provider's ranking is combined by weight (Reciprocal Rank Fusion), so pages several providers return rise; reserved slots still apply.
      </p>
      <div className="flex flex-wrap gap-4">
        <label className={LABEL}>Method
          <select value={policy.fusion} onChange={e => set('fusion', e.target.value as SearchPolicy['fusion'])} className={INPUT}>
            <option value="legacy">Legacy</option>
            <option value="rrf">Rank fusion</option>
          </select>
        </label>
        {policy.fusion === 'rrf' && (
          <label className={LABEL}>RRF k
            <input type="number" min={1} max={1000} value={policy.rrfK} onChange={e => set('rrfK', Number(e.target.value))} className={`${INPUT} w-20`} />
          </label>
        )}
        <label className={LABEL}>Fallback calls per request
          <input type="number" min={0} max={100} value={policy.fallbackBudgetPerRequest} onChange={e => set('fallbackBudgetPerRequest', Number(e.target.value))} className={`${INPUT} w-20`} />
        </label>
        <label className={LABEL}>Web searches per question (0 = unlimited)
          <input type="number" min={0} max={1000} value={policy.maxQueriesPerRequest} onChange={e => set('maxQueriesPerRequest', Number(e.target.value))} className={`${INPUT} w-20`} />
        </label>
        <label className={LABEL}>Fallback below N results
          <input type="number" min={0} max={50} value={policy.fallbackMinResults} onChange={e => set('fallbackMinResults', Number(e.target.value))} className={`${INPUT} w-20`} />
        </label>
      </div>
      <label className="flex items-center gap-2 cursor-pointer w-fit">
        <input type="checkbox" checked={policy.fallbackWhenNoMajorEngine} onChange={e => set('fallbackWhenNoMajorEngine', e.target.checked)} className="accent-blue-500 w-3.5 h-3.5" />
        <span className="text-xs text-gray-400">Also use a fallback when no major engine contributed</span>
      </label>
    </div>
  )
}

/** Admin tab for the search providers: roles, weights, trust and merging, with live counters. */
export function AdminSearchPanel() {
  const confirm = useConfirm()
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchSearchPolicy>> | null>(null)
  const [policy, setPolicy] = useState<SearchPolicy | null>(null)
  const [engineDrafts, setEngineDrafts] = useState<Record<string, string>>({})
  const [status, setStatus] = useState('')

  const load = async () => {
    const d = await fetchSearchPolicy()
    setData(d)
    setPolicy(d.policy)
    setEngineDrafts(Object.fromEntries(Object.entries(d.policy.providers).map(([id, p]) => [id, formatWeights(p.engineWeights)])))
  }
  useEffect(() => { load().catch(e => setStatus(String(e))) }, [])

  if (!data || !policy) return <p className="text-xs text-gray-500">{status || 'Loading…'}</p>

  const handleSave = async () => {
    const providers = Object.fromEntries(Object.entries(policy.providers).map(([id, p]) =>
      [id, { ...p, engineWeights: parseWeights(engineDrafts[id] ?? '') }]))
    try {
      await saveSearchPolicy({ ...policy, providers })
      await load()
      setStatus('Saved ✓')
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const handleReset = async () => {
    if (!await confirm({ message: 'Discard the saved search settings and go back to the env defaults?', confirmLabel: 'Reset', danger: true })) return
    await resetSearchPolicy()
    await load()
    setStatus('Reset to env defaults')
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-gray-500">
        {data.stored ? 'Saved settings override the env defaults.' : 'Showing env defaults — nothing saved yet.'}{' '}
        API keys stay in env. Counters are since server start; monthly usage is per UTC month.
      </p>
      <FusionSettings policy={policy} onChange={setPolicy} />
      <div className="flex flex-col gap-3 border-t border-gray-800 pt-5">
        <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Providers</p>
        {data.providers.map(info => (
          <ProviderCard key={info.id} info={info} policy={policy.providers[info.id]} stats={data.telemetry[info.id]} used={data.usage[info.id] ?? 0}
            engineDraft={engineDrafts[info.id] ?? ''}
            onChange={p => setPolicy({ ...policy, providers: { ...policy.providers, [info.id]: p } })}
            onEngineDraft={text => setEngineDrafts({ ...engineDrafts, [info.id]: text })} />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={handleSave} className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium">Save</button>
        {data.stored && <button onClick={handleReset} className="px-4 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm">Reset to env defaults</button>}
        {status && <span className="text-xs text-gray-400">{status}</span>}
      </div>
    </div>
  )
}
