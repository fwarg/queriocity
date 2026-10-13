import { useState, useEffect } from 'react'
import { useConfirm } from './confirm.tsx'
import { fetchLlmCatalogue, saveLlmCatalogue, testCloudModel } from '../lib/api.ts'
import type { CloudModel, CloudModelRole, CloudProvider, LlmCatalogue } from '@shared/llm-catalogue.ts'

const INPUT = 'px-2 py-1 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500 disabled:opacity-60'
const LABEL = 'flex flex-col gap-1 text-xs text-gray-400'
const BUTTON = 'px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs disabled:opacity-50'

/** Known OpenAI-compatible providers. Cortecs' billing currency is assumed EUR — check it in its console. */
const PRESETS: Array<Omit<CloudProvider, 'enabled' | 'monthlyCap'>> = [
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', currency: 'USD' },
  { id: 'cortecs', label: 'Cortecs', baseURL: 'https://api.cortecs.ai/v1', apiKeyEnv: 'CORTECS_API_KEY', currency: 'EUR' },
]

const BLANK_PROVIDER: CloudProvider = { id: '', label: '', baseURL: 'https://', apiKeyEnv: '', currency: 'USD', monthlyCap: 0, enabled: false }

const blankModel = (providerId: string): CloudModel => ({
  id: '', providerId, model: '', label: '', role: 'chat', contextTokens: 32768, maxOutputTokens: 8000, priceIn: 0, priceOut: 0, enabled: false,
})

type TestResult = { ok: boolean; ms: number; info: string } | 'running'

function TextField({ label, value, onChange, placeholder, disabled, wide }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; wide?: boolean
}) {
  return (
    <label className={`${LABEL} ${wide ? 'flex-1 min-w-48' : ''}`}>{label}
      <input type="text" value={value} placeholder={placeholder} disabled={disabled} onChange={e => onChange(e.target.value)} className={INPUT} />
    </label>
  )
}

function NumberField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className={LABEL}>{label}
      <input type="number" min={0} step={step} value={value} onChange={e => onChange(Number(e.target.value))} className={`${INPUT} w-28`} />
    </label>
  )
}

function EnabledToggle({ checked, onChange, title, subtitle }: { checked: boolean; onChange: (v: boolean) => void; title: string; subtitle?: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer min-w-0">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="accent-blue-500 w-3.5 h-3.5" />
      <span className="text-sm font-medium text-gray-200 truncate">{title || '(new)'}</span>
      {subtitle && <span className="text-xs text-gray-500 truncate">{subtitle}</span>}
    </label>
  )
}

function ProviderCard({ provider, saved, keySet, onChange, onRemove }: {
  provider: CloudProvider; saved: boolean; keySet?: boolean; onChange: (p: CloudProvider) => void; onRemove: () => void
}) {
  const set = <K extends keyof CloudProvider>(k: K, v: CloudProvider[K]) => onChange({ ...provider, [k]: v })
  return (
    <div className="flex flex-col gap-3 border border-gray-800 rounded p-3">
      <div className="flex items-center justify-between gap-2">
        <EnabledToggle checked={provider.enabled} onChange={v => set('enabled', v)} title={provider.label} subtitle={provider.id} />
        {saved && (
          <span className={`text-xs ${keySet ? 'text-green-400' : 'text-amber-400'}`}>
            {keySet ? 'key set' : `key missing — set ${provider.apiKeyEnv}`}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-4">
        <TextField label="Id (fixed once saved)" value={provider.id} disabled={saved} onChange={v => set('id', v)} placeholder="openrouter" />
        <TextField label="Label" value={provider.label} onChange={v => set('label', v)} />
        <TextField label="Base URL" value={provider.baseURL} onChange={v => set('baseURL', v)} wide />
      </div>
      <div className="flex flex-wrap gap-4 items-end">
        <TextField label="API key env var" value={provider.apiKeyEnv} onChange={v => set('apiKeyEnv', v.toUpperCase())} placeholder="OPENROUTER_API_KEY" />
        <TextField label="Currency" value={provider.currency} onChange={v => set('currency', v.toUpperCase())} />
        <NumberField label={`Monthly cap, ${provider.currency} (0 = none)`} value={provider.monthlyCap} onChange={v => set('monthlyCap', v)} step={5} />
        <button onClick={onRemove} className={`${BUTTON} text-red-300`}>Remove</button>
      </div>
    </div>
  )
}

function ModelCard({ model, providers, saved, result, onChange, onRemove, onTest }: {
  model: CloudModel; providers: CloudProvider[]; saved: boolean; result?: TestResult
  onChange: (m: CloudModel) => void; onRemove: () => void; onTest: () => void
}) {
  const set = <K extends keyof CloudModel>(k: K, v: CloudModel[K]) => onChange({ ...model, [k]: v })
  const currency = providers.find(p => p.id === model.providerId)?.currency ?? ''
  return (
    <div className="flex flex-col gap-3 border border-gray-800 rounded p-3">
      <EnabledToggle checked={model.enabled} onChange={v => set('enabled', v)} title={model.label} subtitle={model.model} />
      <div className="flex flex-wrap gap-4">
        <TextField label="Id (fixed once saved)" value={model.id} disabled={saved} onChange={v => set('id', v)} placeholder="sonnet" />
        <TextField label="Label" value={model.label} onChange={v => set('label', v)} />
        <TextField label="Model name at the provider" value={model.model} onChange={v => set('model', v)} placeholder="vendor/model" wide />
      </div>
      <div className="flex flex-wrap gap-4">
        <label className={LABEL}>Provider
          <select value={model.providerId} onChange={e => set('providerId', e.target.value)} className={INPUT}>
            {providers.map(p => <option key={p.id} value={p.id}>{p.label || p.id}</option>)}
          </select>
        </label>
        <label className={LABEL}>Use for
          <select value={model.role} onChange={e => set('role', e.target.value as CloudModelRole)} className={INPUT}>
            <option value="chat">Chat</option>
            <option value="thinking">Thinking</option>
            <option value="both">Both</option>
          </select>
        </label>
        <NumberField label="Context tokens" value={model.contextTokens} onChange={v => set('contextTokens', v)} step={1024} />
        <NumberField label="Max output tokens" value={model.maxOutputTokens} onChange={v => set('maxOutputTokens', v)} step={1000} />
        <NumberField label={`${currency} / M input`} value={model.priceIn} onChange={v => set('priceIn', v)} step={0.01} />
        <NumberField label={`${currency} / M output`} value={model.priceOut} onChange={v => set('priceOut', v)} step={0.01} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onTest} disabled={!saved || result === 'running'} className={BUTTON} title={saved ? 'Sends one tiny request using the saved settings' : 'Save first'}>
          {result === 'running' ? 'Testing…' : 'Test'}
        </button>
        <button onClick={onRemove} className={`${BUTTON} text-red-300`}>Remove</button>
        {result && result !== 'running' && (
          <span className={`text-xs break-all ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
            {result.ok ? '✓' : '✗'} {result.ms} ms — {result.info || '(empty reply)'}
          </span>
        )}
      </div>
    </div>
  )
}

function AddProviderButtons({ existing, onAdd }: { existing: CloudProvider[]; onAdd: (preset?: typeof PRESETS[number]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PRESETS.filter(pr => !existing.some(p => p.id === pr.id)).map(pr => (
        <button key={pr.id} onClick={() => onAdd(pr)} className={BUTTON}>+ {pr.label}</button>
      ))}
      <button onClick={() => onAdd()} className={BUTTON}>+ Other provider</button>
    </div>
  )
}

/** Admin tab for cloud LLM providers and the models users may pick from them. */
export function AdminModelsPanel() {
  const confirm = useConfirm()
  const [catalogue, setCatalogue] = useState<LlmCatalogue | null>(null)
  const [saved, setSaved] = useState<LlmCatalogue>({ providers: [], models: [] })
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [status, setStatus] = useState('')

  const load = async () => {
    const d = await fetchLlmCatalogue()
    setCatalogue(d.catalogue)
    setSaved(d.catalogue)
    setKeys(d.keys)
  }
  useEffect(() => { load().catch(e => setStatus(String(e))) }, [])

  if (!catalogue) return <p className="text-xs text-gray-500">{status || 'Loading…'}</p>

  const isSavedProvider = (id: string) => saved.providers.some(p => p.id === id)
  const isSavedModel = (id: string) => saved.models.some(m => m.id === id)
  const setProvider = (i: number, p: CloudProvider) => {
    const old = catalogue.providers[i].id
    // An unsaved provider's id may still change; its models follow it.
    const models = catalogue.models.map(m => m.providerId === old ? { ...m, providerId: p.id } : m)
    setCatalogue({ providers: catalogue.providers.map((x, j) => j === i ? p : x), models })
  }
  const setModel = (i: number, m: CloudModel) => setCatalogue({ ...catalogue, models: catalogue.models.map((x, j) => j === i ? m : x) })

  const addProvider = (preset?: typeof PRESETS[number]) =>
    setCatalogue({ ...catalogue, providers: [...catalogue.providers, { ...BLANK_PROVIDER, ...preset }] })

  const removeProvider = async (i: number) => {
    const p = catalogue.providers[i]
    const count = catalogue.models.filter(m => m.providerId === p.id).length
    if (count && !await confirm({ message: `Remove ${p.label || p.id} and its ${count} model(s)? Takes effect on Save.`, confirmLabel: 'Remove', danger: true })) return
    setCatalogue({ providers: catalogue.providers.filter((_, j) => j !== i), models: catalogue.models.filter(m => m.providerId !== p.id) })
  }

  const handleSave = async () => {
    try {
      await saveLlmCatalogue(catalogue)
      await load()
      setStatus('Saved ✓')
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const runTest = async (id: string) => {
    setResults(r => ({ ...r, [id]: 'running' }))
    const result = await testCloudModel(id).catch(e => ({ ok: false, ms: 0, info: String(e) }))
    setResults(r => ({ ...r, [id]: result }))
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-gray-500">
        Cloud models users can pick for a single message instead of the local model. Their prompts — including memory and document excerpts — go to the provider.
        API keys stay in env; each provider names its env var. Locked spaces, image mode, monitors and background helpers always stay local.
      </p>
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Providers</p>
        {catalogue.providers.map((p, i) => (
          <ProviderCard key={i} provider={p} saved={isSavedProvider(p.id)} keySet={keys[p.apiKeyEnv]}
            onChange={v => setProvider(i, v)} onRemove={() => removeProvider(i)} />
        ))}
        <AddProviderButtons existing={catalogue.providers} onAdd={addProvider} />
      </div>
      <div className="flex flex-col gap-3 border-t border-gray-800 pt-5">
        <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Models</p>
        {catalogue.models.map((m, i) => (
          <ModelCard key={i} model={m} providers={catalogue.providers} saved={isSavedModel(m.id)} result={results[m.id]}
            onChange={v => setModel(i, v)} onTest={() => runTest(m.id)}
            onRemove={() => setCatalogue({ ...catalogue, models: catalogue.models.filter((_, j) => j !== i) })} />
        ))}
        {catalogue.providers.length > 0
          ? <button onClick={() => setCatalogue({ ...catalogue, models: [...catalogue.models, blankModel(catalogue.providers[0].id)] })} className={`${BUTTON} self-start`}>+ Model</button>
          : <p className="text-xs text-gray-500">Add a provider first.</p>}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={handleSave} className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium">Save</button>
        {status && <span className="text-xs text-gray-400">{status}</span>}
      </div>
    </div>
  )
}
