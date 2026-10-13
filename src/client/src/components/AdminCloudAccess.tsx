import { useState, useEffect } from 'react'
import { fetchLlmUsage, saveLlmAccess, listUsers } from '../lib/api.ts'
import type { CloudProvider, LlmAccess, LlmCatalogue, UsageRow } from '@shared/llm-catalogue.ts'

const INPUT = 'px-2 py-1 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500'
const BUTTON = 'px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs disabled:opacity-50'

type User = Awaited<ReturnType<typeof listUsers>>[number]
/** Budgets as typed: blank means no access to that provider. */
type Draft = { cloudEnabled: boolean; budgets: Record<string, string> }

const money = (n: number, currency: string) => `${n.toFixed(2)} ${currency}`
const spendOf = (usage: UsageRow[], providerId: string, userId?: string) =>
  usage.filter(r => r.providerId === providerId && (!userId || r.userId === userId)).reduce((s, r) => s + r.cost, 0)

const toDraft = (a?: LlmAccess): Draft => ({
  cloudEnabled: a?.cloudEnabled ?? false,
  budgets: Object.fromEntries(Object.entries(a?.budgets ?? {}).map(([p, b]) => [p, String(b)])),
})
const fromDraft = (d: Draft): LlmAccess => ({
  cloudEnabled: d.cloudEnabled,
  budgets: Object.fromEntries(Object.entries(d.budgets).filter(([, v]) => v.trim() !== '').map(([p, v]) => [p, Number(v)])),
})

function ProviderSpend({ providers, usage, month }: { providers: CloudProvider[]; usage: UsageRow[]; month: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-gray-400 font-medium">Spend in {month} (UTC)</p>
      {providers.map(p => {
        const spent = spendOf(usage, p.id)
        const over = p.monthlyCap > 0 && spent >= 0.8 * p.monthlyCap
        return (
          <p key={p.id} className={`text-xs ${over ? 'text-amber-400' : 'text-gray-500'}`}>
            {p.label || p.id}: {money(spent, p.currency)}{p.monthlyCap > 0 ? ` of ${money(p.monthlyCap, p.currency)} cap` : ' (no cap)'}
          </p>
        )
      })}
    </div>
  )
}

function UserAccessRow({ user, providers, usage, initial, onSaved }: {
  user: User; providers: CloudProvider[]; usage: UsageRow[]; initial: Draft; onSaved: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [status, setStatus] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const save = async () => {
    try {
      await saveLlmAccess(user.id, fromDraft(draft))
      setStatus('Saved ✓')
      onSaved()
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="flex flex-col gap-2 border border-gray-800 rounded p-3">
      <label className="flex items-center gap-2 cursor-pointer min-w-0">
        <input type="checkbox" checked={draft.cloudEnabled} onChange={e => setDraft({ ...draft, cloudEnabled: e.target.checked })} className="accent-blue-500 w-3.5 h-3.5" />
        <span className="text-sm text-gray-200 truncate">{user.email}</span>
        <span className="text-xs text-gray-500">cloud models</span>
      </label>
      <div className="flex flex-wrap gap-4">
        {providers.map(p => (
          <label key={p.id} className="flex flex-col gap-1 text-xs text-gray-400">
            {p.label || p.id} budget, {p.currency}
            <input type="number" min={0} step={1} placeholder="no access" value={draft.budgets[p.id] ?? ''}
              onChange={e => setDraft({ ...draft, budgets: { ...draft.budgets, [p.id]: e.target.value } })} className={`${INPUT} w-28`} />
            <span className="text-gray-500">spent {money(spendOf(usage, p.id, user.id), p.currency)}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={!dirty} className={BUTTON}>Save</button>
        {status && <span className="text-xs text-gray-400">{status}</span>}
      </div>
    </div>
  )
}

/** Per-user cloud access and budgets, with this month's spend against each provider's cap. */
export function AdminCloudAccess({ catalogue }: { catalogue: LlmCatalogue }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchLlmUsage>> | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [error, setError] = useState('')

  const load = async () => {
    const [d, u] = await Promise.all([fetchLlmUsage(), listUsers()])
    setData(d)
    setUsers(u)
  }
  useEffect(() => { load().catch(e => setError(String(e))) }, [])

  if (!data) return <p className="text-xs text-gray-500">{error || 'Loading…'}</p>
  if (!catalogue.providers.length) return <p className="text-xs text-gray-500">Save a provider to grant access to it.</p>

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-gray-500">
        A user can pick cloud models only when cloud models are switched on for them and they have a budget for that provider.
        Budgets and caps are per UTC month, in the provider's currency, priced from the catalogue.
      </p>
      <ProviderSpend providers={catalogue.providers} usage={data.usage} month={data.month} />
      {users.map(u => (
        // Keyed on the stored access too, so a reload after saving resets the row's draft.
        <UserAccessRow key={`${u.id}:${JSON.stringify(data.access[u.id] ?? null)}`} user={u} providers={catalogue.providers}
          usage={data.usage} initial={toDraft(data.access[u.id])} onSaved={() => { load().catch(e => setError(String(e))) }} />
      ))}
    </div>
  )
}
