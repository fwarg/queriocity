import { useState, useEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import { TEMPLATES, type Template, type FocusMode } from '../lib/templates.ts'

interface Props {
  onSelect: (text: string, mode: FocusMode) => void
  onClose: () => void
}

const MODE_COLORS: Record<FocusMode, string> = {
  flash: 'bg-yellow-700 text-yellow-100',
  fast: 'bg-green-700 text-green-100',
  balanced: 'bg-blue-700 text-blue-100',
  thorough: 'bg-purple-700 text-purple-100',
}

export function TemplateSelector({ onSelect, onClose }: Props) {
  const [active, setActive] = useState<Template | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
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

  const canSubmit = active
    ? active.fields.filter(f => f.required).every(f => values[f.id]?.trim())
    : false

  return (
    <>
      {/* backdrop */}
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        className="absolute bottom-full left-0 right-0 mb-2 z-20 rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
      >
        {!active ? (
          <div className="p-3">
            <p className="text-xs text-gray-400 mb-2 px-1">Choose a prompt template</p>
            <div className="grid grid-cols-2 gap-2">
              {TEMPLATES.map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => selectTemplate(t)}
                  className="text-left p-3 rounded-md bg-gray-800 hover:bg-gray-700 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="text-sm font-medium text-white leading-tight">{t.name}</span>
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${MODE_COLORS[t.suggestedMode]}`}>
                      {t.suggestedMode}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 leading-snug">{t.description}</p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-3">
            <div className="flex items-center gap-2 mb-3">
              <button
                type="button"
                onClick={back}
                className="text-gray-400 hover:text-white p-1 -ml-1 rounded"
                aria-label="Back to template list"
              >
                <ArrowLeft size={14} />
              </button>
              <span className="text-sm font-medium text-white">{active.name}</span>
              <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium ${MODE_COLORS[active.suggestedMode]}`}>
                {active.suggestedMode}
              </span>
            </div>

            <div className="flex flex-col gap-2.5">
              {active.fields.map(field => (
                <div key={field.id}>
                  <label className="block text-xs text-gray-400 mb-1">
                    {field.label}
                    {field.required && <span className="text-blue-400 ml-0.5">*</span>}
                  </label>

                  {field.type === 'select' ? (
                    <select
                      value={values[field.id] ?? field.defaultValue ?? ''}
                      onChange={e => setValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                    >
                      {field.options?.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
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
                      <span className="text-sm text-gray-300">Yes</span>
                    </label>
                  ) : (
                    <input
                      type="text"
                      value={values[field.id] ?? ''}
                      onChange={e => setValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                      placeholder={field.placeholder}
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
              Use template
            </button>
          </div>
        )}
      </div>
    </>
  )
}
