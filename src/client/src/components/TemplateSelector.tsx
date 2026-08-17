import { useState, useEffect, useRef } from 'react'
import { useConfirm } from './confirm.tsx'
import { ArrowLeft, Pencil, Trash2, Plus } from 'lucide-react'
import { TEMPLATES, type Template, type FocusMode, type TemplateField } from '../lib/templates.ts'
import { fetchCustomTemplates, deleteCustomTemplate, type CustomTemplate } from '../lib/api.ts'
import { PromptStudio } from './PromptStudio.tsx'
import { useT } from '../lib/i18n.tsx'
import type { TranslationKey } from '@shared/i18n/index.ts'

/** Copy for the built-in templates is keyed by the ids already in templates.ts rather than by
 *  extra fields on the data, so adding a template is one entry there and a block in the catalogs.
 *
 *  The cast is what a runtime-assembled key costs; templates-i18n.test.ts asserts every id in
 *  TEMPLATES resolves, which is the check the compiler cannot do here. Custom templates are the
 *  user's own words and are shown as written. */
const templateKey = (...parts: string[]): TranslationKey => `template.${parts.join('.')}` as TranslationKey

/** Select options are shown translated but stored — and sent to the model — as the English token
 *  the template's `assemble()` builds its prompt from. Translating the value would change what the
 *  model is asked; translating only the label is the whole point of the split. */
const optionSlug = (option: string) => option.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Modes are labelled the same way as in the composer. */
const MODE_LABEL_KEYS: Record<FocusMode, TranslationKey> = {
  flash: 'mode.flash',
  balanced: 'mode.balanced',
  thorough: 'mode.thorough',
  image: 'mode.image',
}

interface Props {
  onSelect: (text: string, mode: FocusMode) => void
  onClose: () => void
}

const MODE_COLORS: Record<FocusMode, string> = {
  flash: 'bg-yellow-700 text-yellow-100',
  balanced: 'bg-blue-700 text-blue-100',
  thorough: 'bg-purple-700 text-purple-100',
  image: 'bg-pink-700 text-pink-100',
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

function customToTemplate(ct: CustomTemplate): Template {
  const fieldIds = [...ct.promptText.matchAll(PLACEHOLDER_RE)]
    .map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i)
  const fields: TemplateField[] = fieldIds.map(id => ({
    id,
    label: id.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()),
    placeholder: `{{${id}}}`,
    required: false,
    type: 'text' as const,
  }))
  return {
    id: ct.id,
    name: ct.name,
    description: ct.description ?? '',
    suggestedMode: ct.suggestedMode as FocusMode,
    fields,
    assemble: (values) => ct.promptText.replace(PLACEHOLDER_RE, (_, name) => values[name] ?? `{{${name}}}`),
  }
}

export function TemplateSelector({ onSelect, onClose }: Props) {
  const t = useT()
  const confirm = useConfirm()
  const [active, setActive] = useState<Template | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>([])
  const [studio, setStudio] = useState<'create' | CustomTemplate | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const studioRef = useRef<'create' | CustomTemplate | null>(null)

  useEffect(() => { studioRef.current = studio }, [studio])

  useEffect(() => {
    fetchCustomTemplates().then(setCustomTemplates).catch(() => {})
  }, [])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !studioRef.current) onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  function selectTemplate(t: Template) {
    const defaults: Record<string, string> = {}
    for (const f of t.fields) {
      if (f.defaultValue !== undefined) defaults[f.id] = f.defaultValue
    }
    setValues(defaults)
    setActive(t)
  }

  function back() {
    setActive(null)
    setValues({})
  }

  function handleUse() {
    if (!active) return
    onSelect(active.assemble(values), active.suggestedMode)
  }

  async function handleDeleteCustom(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    if (!await confirm({ message: t('template.deleteConfirm'), confirmLabel: t('common.delete'), danger: true })) return
    await deleteCustomTemplate(id)
    setCustomTemplates(prev => prev.filter(t => t.id !== id))
  }

  function handleStudioSave(saved: CustomTemplate) {
    setCustomTemplates(prev => {
      const idx = prev.findIndex(t => t.id === saved.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = saved
        return next
      }
      return [saved, ...prev]
    })
    setStudio(null)
  }

  const canSubmit = active
    ? active.fields.filter(f => f.required).every(f => values[f.id]?.trim())
    : false

  return (
    <>
      {studio !== null && (
        <PromptStudio
          initial={studio === 'create' ? undefined : studio}
          onSave={handleStudioSave}
          onClose={() => setStudio(null)}
        />
      )}

      {/* backdrop */}
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        className="absolute bottom-full left-0 right-0 mb-2 z-20 rounded-lg border border-gray-700 bg-gray-900 shadow-xl max-h-[70vh] overflow-y-auto"
      >
        {!active ? (
          <div className="p-3">
            <p className="text-xs text-gray-400 mb-2 px-1">{t('template.choose')}</p>

            {/* Built-in templates */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {TEMPLATES.map(tpl => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => selectTemplate(tpl)}
                  className="text-left p-3 rounded-md bg-gray-800 hover:bg-gray-700 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="text-sm font-medium text-white leading-tight">{t(templateKey(tpl.id, 'name'))}</span>
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${MODE_COLORS[tpl.suggestedMode]}`}>
                      {t(MODE_LABEL_KEYS[tpl.suggestedMode])}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 leading-snug">{t(templateKey(tpl.id, 'desc'))}</p>
                </button>
              ))}
            </div>

            {/* Custom templates */}
            {customTemplates.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-2 px-1">{t('template.custom')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {customTemplates.map(ct => (
                    <div key={ct.id} className="relative group">
                      <button
                        type="button"
                        onClick={() => selectTemplate(customToTemplate(ct))}
                        className="w-full text-left p-3 rounded-md bg-gray-800 hover:bg-gray-700 transition-colors pr-14"
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="text-sm font-medium text-white leading-tight">{ct.name}</span>
                          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${MODE_COLORS[ct.suggestedMode as FocusMode] ?? MODE_COLORS.balanced}`}>
                            {t(MODE_LABEL_KEYS[ct.suggestedMode])}
                          </span>
                        </div>
                        {ct.description && (
                          <p className="text-xs text-gray-400 leading-snug">{ct.description}</p>
                        )}
                      </button>
                      <div className="absolute top-2 right-2 flex gap-1">
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setStudio(ct) }}
                          className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-600 transition-colors"
                          aria-label={t('template.edit')}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={e => handleDeleteCustom(e, ct.id)}
                          className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-600 transition-colors"
                          aria-label={t('template.delete')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Create button */}
            <button
              type="button"
              onClick={() => setStudio('create')}
              className="mt-3 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md border border-dashed border-gray-700 text-xs text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors"
            >
              <Plus size={12} />
              {t('template.create')}
            </button>
          </div>
        ) : (() => {
          // Custom templates are turned into Templates with a `custom-` id; only the built-ins
          // have catalog entries, and only they should be looked up.
          const isBuiltIn = TEMPLATES.some(tpl => tpl.id === active.id)
          const activeName = isBuiltIn ? t(templateKey(active.id, 'name')) : active.name
          return (
          <div className="p-3">
            <div className="flex items-center gap-2 mb-3">
              <button
                type="button"
                onClick={back}
                className="text-gray-400 hover:text-white p-1 -ml-1 rounded"
                aria-label={t('template.back')}
              >
                <ArrowLeft size={14} />
              </button>
              <span className="text-sm font-medium text-white">{activeName}</span>
              <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium ${MODE_COLORS[active.suggestedMode]}`}>
                {t(MODE_LABEL_KEYS[active.suggestedMode])}
              </span>
            </div>

            <div className="flex flex-col gap-2.5">
              {active.fields.map(field => (
                <div key={field.id}>
                  <label className="block text-xs text-gray-400 mb-1">
                    {isBuiltIn ? t(templateKey(active.id, field.id, 'label')) : field.label}
                    {field.required && <span className="text-blue-400 ml-0.5">*</span>}
                  </label>

                  {field.type === 'select' ? (
                    <select
                      value={values[field.id] ?? field.defaultValue ?? ''}
                      onChange={e => setValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                    >
                      {field.options?.map(opt => (
                        <option key={opt} value={opt}>
                          {isBuiltIn ? t(templateKey(active.id, field.id, 'opt', optionSlug(opt))) : opt}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'toggle' ? (
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={values[field.id] !== 'false'}
                        onChange={e => setValues(prev => ({ ...prev, [field.id]: e.target.checked ? 'true' : 'false' }))}
                        className="rounded accent-blue-500"
                      />
                      <span className="text-sm text-gray-300">{t('common.yes')}</span>
                    </label>
                  ) : (
                    <input
                      type="text"
                      value={values[field.id] ?? ''}
                      onChange={e => setValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                      placeholder={isBuiltIn && field.placeholder ? t(templateKey(active.id, field.id, 'ph')) : field.placeholder}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500 placeholder-gray-600"
                    />
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={handleUse}
              disabled={!canSubmit}
              className="mt-3 w-full py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm font-medium transition-colors"
            >
              {t('template.use')}
            </button>
          </div>
          )
        })()}
      </div>
    </>
  )
}
