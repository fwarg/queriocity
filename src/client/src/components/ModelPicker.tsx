import type { PickableModel } from '@shared/llm-catalogue.ts'
import { useT, type TFunction } from '../lib/i18n.tsx'

const optionLabel = (m: PickableModel, t: TFunction) => [
  m.label,
  m.role === 'thinking' ? ` (${t('model.thinking')})` : '',
  m.remaining !== undefined ? ` — ${t('model.remaining', { amount: m.remaining.toFixed(2), currency: m.currency ?? '' })}` : '',
].join('')

/** Chooses the model for the next message only. Hidden when the user has nothing to choose from. */
export function ModelPicker({ models, value, onChange }: { models: PickableModel[]; value: string; onChange: (id: string) => void }) {
  const t = useT()
  if (!models.length) return null
  const chosen = models.find(m => m.id === value)
  const groups = (['cloud', 'local'] as const)
    .map(kind => ({ kind, items: models.filter(m => m.kind === kind) }))
    .filter(g => g.items.length)
  // A cloud model is sent the prompt with everything in it, so the tooltip says so.
  const title = chosen?.kind === 'cloud' ? t('model.cloudNote', { provider: chosen.providerLabel }) : t('model.pickTitle')
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      title={title}
      aria-label={t('model.pickTitle')}
      className={`max-w-[12rem] truncate px-2 py-1 rounded text-xs border focus:outline-none ${value ? 'bg-amber-700 text-white border-amber-600' : 'bg-gray-800 text-gray-400 border-gray-800 hover:bg-gray-700'}`}
    >
      <option value="">{t('model.default')}</option>
      {groups.map(g => (
        <optgroup key={g.kind} label={t(g.kind === 'cloud' ? 'model.groupCloud' : 'model.groupLocal')}>
          {g.items.map(m => <option key={m.id} value={m.id}>{optionLabel(m, t)}</option>)}
        </optgroup>
      ))}
    </select>
  )
}
