import { useState, useEffect, useCallback } from 'react'
import { fetchLlmUsage, fetchLlmCatalogue, saveLlmAccess } from '../lib/api.ts'
import type { CloudProvider, LlmAccess, UsageRow } from '@shared/llm-catalogue.ts'

const INPUT = 'px-2 py-1 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500'
const BUTTON = 'px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs disabled:opacity-50'

/** Budgets as typed: blank means no access to that provider. */
type Draft = { cloudEnabled: boolean; budgets: Record<string, string> }

const money = (n: number, currency: string) => `${n.toFixed(2)} ${currency}`
const spendOf = (usage: UsageRow[], providerId: string, userId?: string) =>
  usage.filter(r => r.providerId === providerId && (!userId || r.userId === userId)).reduce((s, r) => s + r.cost, 0)

const withAccess = (budgets: Record<string, string>, providerId: string, on: boolean) =>
  on ? { ...budgets, [providerId]: '0' } : Object.fromEntries(Object.entries(budgets).filter(([p]) => p !== providerId))

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
      {providers.filter(p => p.kind === 'cloud').map(p => {
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

function UserAccessRow({ userId, providers, usage, initial, onSaved }: {
  userId: string; providers: CloudProvider[]; usage: UsageRow[]; initial: Draft; onSaved: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [status, setStatus] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const save = async () => {
    try {
      await saveLlmAccess(userId, fromDraft(draft))
      setStatus('Saved ✓')
      onSaved()
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="flex flex-col gap-2 py-2">
      <label className="flex items-center gap-2 cursor-pointer min-w-0">
        <input type="checkbox" checked={draft.cloudEnabled} onChange={e => setDraft({ ...draft, cloudEnabled: e.target.checked })} className="accent-blue-500 w-3.5 h-3.5" />
        <span className="text-xs text-gray-300">May pick models for a message</span>
      </label>
      <div className="flex flex-wrap gap-4">
        {providers.map(p => p.kind === 'local' ? (
          <label key={p.id} className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            {/* Not metered: access is all there is to grant. Stored as a budget of 0. */}
            <input type="checkbox" checked={draft.budgets[p.id] !== undefined} className="accent-blue-500 w-3.5 h-3.5"
              onChange={e => setDraft({ ...draft, budgets: withAccess(draft.budgets, p.id, e.target.checked) })} />
            {p.label || p.id}
          </label>
        ) : (
          <label key={p.id} className="flex flex-col gap-1 text-xs text-gray-400">
            {p.label || p.id} budget, {p.currency}
            <input type="number" min={0} step={1} placeholder="no access" value={draft.budgets[p.id] ?? ''}
              onChange={e => setDraft({ ...draft, budgets: { ...draft.budgets, [p.id]: e.target.value } })} className={`${INPUT} w-28`} />
            <span className="text-gray-500">spent {money(spendOf(usage, p.id, userId), p.currency)}</span>
          </label>
        ))}
      </div>
      {draft.cloudEnabled && providers.some(p => p.kind === 'cloud' && (draft.budgets[p.id] ?? '').trim() !== '') && (
        <p className="text-xs text-amber-400">
          With a cloud budget this user can send their prompts — the whole conversation, memory and document excerpts — to that provider, outside this server.
          They confirm once that they understand this before their first cloud message.
        </p>
      )}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={!dirty} className={BUTTON}>Save</button>
        {status && <span className="text-xs text-gray-400">{status}</span>}
      </div>
    </div>
  )
}

/** The saved providers and this month's access and spend: what the access panels and the spend summary show. */
export function useCloudAccessData(enabled: boolean) {
  const [providers, setProviders] = useState<CloudProvider[]>([])
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchLlmUsage>> | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    Promise.all([fetchLlmCatalogue(), fetchLlmUsage()])
      .then(([c, d]) => { setProviders(c.catalogue.providers); setData(d) })
      .catch(e => setError(String(e)))
  }, [])
  useEffect(() => { if (enabled) load() }, [enabled, load])
  return { providers, data, error, reload: load }
}

export type CloudAccessData = ReturnType<typeof useCloudAccessData>

/** One user's model picking, budgets and spend, folded out under their row in the Users tab. */
export function UserCloudAccess({ userId, cloud }: { userId: string; cloud: CloudAccessData }) {
  if (!cloud.data) return <p className="text-xs text-gray-500">{cloud.error || 'Loading…'}</p>
  if (!cloud.providers.length) return <p className="text-xs text-gray-500">No model providers yet — add them under Admin → Models.</p>
  const access = cloud.data.access[userId]
  // Keyed on the stored access, so a reload after saving resets the draft.
  return <UserAccessRow key={JSON.stringify(access ?? null)} userId={userId} providers={cloud.providers}
    usage={cloud.data.usage} initial={toDraft(access)} onSaved={cloud.reload} />
}

/** Whether a user may pick models, for the Users tab's row button. */
export const pickingEnabled = (cloud: CloudAccessData, userId: string) => !!cloud.data?.access[userId]?.cloudEnabled

/** This month's spend per cloud provider against its cap, for the Models tab. */
export function CloudSpendSummary({ providers }: { providers: CloudProvider[] }) {
  const cloud = useCloudAccessData(true)
  if (!cloud.data) return <p className="text-xs text-gray-500">{cloud.error || 'Loading…'}</p>
  return (
    <div className="flex flex-col gap-2">
      <ProviderSpend providers={providers} usage={cloud.data.usage} month={cloud.data.month} />
      <p className="text-xs text-gray-500">
        Who may pick models, with a budget per cloud provider or a tick per local one, is set per user under Admin → Users.
        Budgets and caps are per UTC month, in the provider's currency.
      </p>
    </div>
  )
}
