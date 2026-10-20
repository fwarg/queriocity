import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { fetchSpaces, type Space } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { LinkPicker } from './LinkPicker.tsx'
import { COLLECTION_MODE_LABEL_KEYS } from './ChatInput.tsx'
import { COLLECTION_MODES } from '@shared/context.ts'
import { MAX_EXAMPLES, MAX_INSTRUCTION_NOTES, MAX_INSTRUCTION_TEXT, type RecipeSettings } from '@shared/recipes.ts'

export interface Picked { id: string; title: string }

export interface RecipeDraft {
  /** Rules typed into the recipe; notes hold longer or shared guides. */
  instructionText: string
  instructions: Picked[]
  examples: Picked[]
  settings: RecipeSettings
}

/** Prompt Studio's recipe section: the notes that instruct, the resources to imitate, and the chat
 *  settings applied on picking. All empty, the template stays a plain one. */
export function RecipeParts({ draft, onChange }: { draft: RecipeDraft; onChange: (d: RecipeDraft) => void }) {
  const t = useT()
  const [picking, setPicking] = useState<'instructions' | 'examples' | null>(null)
  const [collections, setCollections] = useState<Space[]>([])

  useEffect(() => { fetchSpaces().then(s => setCollections(s.filter(sp => sp.kind === 'collection'))).catch(() => {}) }, [])

  const set = (patch: Partial<RecipeDraft>) => onChange({ ...draft, ...patch })
  const setSettings = (patch: Partial<RecipeSettings>) => set({ settings: { ...draft.settings, ...patch } })
  const picked = draft.settings.collectionIds ?? []
  const mode = draft.settings.collectionMode ?? 'auto'

  function add(list: 'instructions' | 'examples', title: string, id: string) {
    if (!draft[list].some(p => p.id === id)) set({ [list]: [...draft[list], { id, title }] })
    setPicking(null)
  }

  function toggleCollection(id: string) {
    const next = picked.includes(id) ? picked.filter(c => c !== id) : [...picked, id]
    setSettings({ collectionIds: next.length ? next : undefined })
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs text-gray-400 font-medium">{t('recipe.section')}</p>
        <p className="text-xs text-gray-500">{t('recipe.sectionDesc')}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <PickedList
          label={t('recipe.instructions')} hint={t('recipe.instructionsDesc')} items={draft.instructions}
          onRemove={id => set({ instructions: draft.instructions.filter(p => p.id !== id) })}
          onAdd={draft.instructions.length < MAX_INSTRUCTION_NOTES ? () => setPicking('instructions') : undefined}
        />
        <textarea
          value={draft.instructionText}
          onChange={e => set({ instructionText: e.target.value })}
          maxLength={MAX_INSTRUCTION_TEXT}
          rows={3}
          aria-label={t('recipe.instructionText')}
          placeholder={t('recipe.instructionTextPlaceholder')}
          className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:border-blue-500 resize-y"
        />
      </div>
      <PickedList
        label={t('recipe.examples')} hint={t('recipe.examplesDesc')} items={draft.examples}
        onRemove={id => set({ examples: draft.examples.filter(p => p.id !== id) })}
        onAdd={draft.examples.length < MAX_EXAMPLES ? () => setPicking('examples') : undefined}
      />
      {collections.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-gray-400">{t('recipe.collections')}</p>
          <p className="text-xs text-gray-500">{t('recipe.collectionsDesc')}</p>
          <div className="flex flex-wrap gap-1">
            {collections.map(c => (
              <button key={c.id} type="button" onClick={() => toggleCollection(c.id)}
                className={`px-2 py-0.5 rounded text-xs ${picked.includes(c.id) ? 'bg-amber-700 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'}`}>
                {c.name}
              </button>
            ))}
          </div>
          {picked.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <select value={mode} onChange={e => setSettings({ collectionMode: e.target.value as RecipeSettings['collectionMode'] })}
                aria-label={t('collection.modeGroup')}
                className="rounded bg-gray-800 border border-gray-700 px-2 py-1 text-xs focus:outline-none focus:border-blue-500">
                {COLLECTION_MODES.map(m => <option key={m} value={m}>{t(COLLECTION_MODE_LABEL_KEYS[m])}</option>)}
              </select>
              {mode === 'explore' && (
                <label className="inline-flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
                  <input type="checkbox" checked={draft.settings.exploreWeb === true} onChange={e => setSettings({ exploreWeb: e.target.checked || undefined })} className="accent-amber-600" />
                  {t('collection.exploreWeb')}
                </label>
              )}
            </div>
          )}
        </div>
      )}
      </div>
      {picking && (
        <LinkPicker
          notesOnly={picking === 'instructions'}
          title={t(picking === 'instructions' ? 'recipe.pickInstruction' : 'recipe.pickExample')}
          onPick={(title, r) => add(picking, title, r.id)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}

function PickedList({ label, hint, items, onRemove, onAdd }: {
  label: string; hint: string; items: Picked[]; onRemove: (id: string) => void; onAdd?: () => void
}) {
  const t = useT()
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-xs text-gray-500">{hint}</p>
      <div className="flex flex-wrap gap-1">
        {items.map(p => (
          <span key={p.id} className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200">
            <span className="truncate">{p.title}</span>
            <button type="button" onClick={() => onRemove(p.id)} aria-label={t('recipe.remove', { title: p.title })} className="shrink-0 text-gray-500 hover:text-gray-200"><X size={12} /></button>
          </span>
        ))}
        {onAdd && (
          <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-dashed border-gray-700 text-xs text-gray-500 hover:text-gray-300 hover:border-gray-500">
            <Plus size={12} />{t('recipe.add')}
          </button>
        )}
      </div>
    </div>
  )
}
