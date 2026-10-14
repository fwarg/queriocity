import type { PickableModel } from '@shared/llm-catalogue.ts'
import { useT, type TFunction } from '../lib/i18n.tsx'

interface Group {
  key: string
  label: string
  models: PickableModel[]
}

/** One group per cloud provider, headed by what is left of its budget (budgets are per provider, so
 *  the amount belongs there rather than on each model); local models share one group. */
function groupsOf(models: PickableModel[], t: TFunction): Group[] {
  const cloud = [...new Set(models.filter(m => m.kind === 'cloud').map(m => m.providerId))].map(providerId => {
    const items = models.filter(m => m.providerId === providerId)
    const { providerLabel, remaining, currency } = items[0]
    const left = remaining !== undefined ? ` — ${t('model.remaining', { amount: remaining.toFixed(2), currency: currency ?? '' })}` : ''
    return { key: providerId, label: t('model.groupCloud', { provider: providerLabel }) + left, models: items }
  })
  const local = models.filter(m => m.kind === 'local')
  return local.length ? [...cloud, { key: 'local', label: t('model.groupLocal'), models: local }] : cloud
}

const optionLabel = (m: PickableModel, t: TFunction) => m.role === 'thinking' ? `${m.label} (${t('model.thinking')})` : m.label

/** Chooses the model for this chat's messages. Hidden when the user has nothing to choose from.
 *  `defaultModel` names the model "default" stands for in the current mode. */
export function ModelPicker({ models, value, onChange, defaultModel }: {
  models: PickableModel[]; value: string; onChange: (id: string) => void; defaultModel?: string
}) {
  const t = useT()
  if (!models.length) return null
  const chosen = models.find(m => m.id === value)
  // A cloud model is sent the prompt with everything in it, so the tooltip says so.
  const title = chosen?.kind === 'cloud' ? t('model.cloudNote', { provider: chosen.providerLabel }) : t('model.pickTitle')
  const defaultLabel = defaultModel ? t('model.defaultNamed', { model: defaultModel }) : t('model.default')
  // Amber for a model that leaves the server, the same colour as its warning and badge.
  const tone = chosen?.kind === 'cloud' ? 'bg-amber-700 text-white border-amber-600'
    : chosen ? 'bg-gray-700 text-gray-100 border-gray-600'
      : 'bg-gray-800 text-gray-400 border-gray-800 hover:bg-gray-700'
  return (
    // autoComplete off: a browser restoring the last selection on reload (Firefox does) would show
    // one model while the app's state holds another.
    <select
      autoComplete="off"
      value={value}
      onChange={e => onChange(e.target.value)}
      title={title}
      aria-label={t('model.pickTitle')}
      className={`max-w-[14rem] truncate px-2 py-1 rounded text-xs border focus:outline-none ${tone}`}
    >
      <option value="">{defaultLabel}</option>
      {groupsOf(models, t).map(g => (
        <optgroup key={g.key} label={g.label}>
          {g.models.map(m => <option key={m.id} value={m.id}>{optionLabel(m, t)}</option>)}
        </optgroup>
      ))}
    </select>
  )
}
