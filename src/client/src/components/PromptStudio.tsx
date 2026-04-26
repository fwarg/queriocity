import { useState, useRef, useEffect } from 'react'
import { Modal } from './Modal.tsx'
import { streamChat, createCustomTemplate, updateCustomTemplate, type CustomTemplate } from '../lib/api.ts'
import type { FocusMode } from '../lib/templates.ts'

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

function extractFields(text: string): string[] {
  const seen = new Set<string>()
  for (const [, name] of text.matchAll(PLACEHOLDER_RE)) seen.add(name)
  return [...seen]
}

function fieldLabel(id: string): string {
  return id.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim()
    .replace(/^\w/, c => c.toUpperCase())
}

function assemble(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_, name) => values[name] || name)
}

interface Props {
  initial?: CustomTemplate
  onSave: (t: CustomTemplate) => void
  onClose: () => void
}

const MODE_OPTIONS: FocusMode[] = ['flash', 'balanced', 'thorough']

export function PromptStudio({ initial, onSave, onClose }: Props) {
  const [promptText, setPromptText] = useState(initial?.promptText ?? '')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<FocusMode>(initial?.suggestedMode ?? 'balanced')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const fields = extractFields(promptText)
  const assembled = assemble(promptText, fieldValues)
  const canRun = promptText.trim().length > 0 && !running
  const canSave = name.trim().length > 0 && promptText.trim().length > 0 && !saving

  async function handleRun() {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setOutput('')
    setStatus('')
    setRunning(true)
    let accumulated = ''
    try {
      for await (const chunk of streamChat(
        [{ role: 'user', content: assembled }],
        mode,
        undefined,
        ctrl.signal,
      )) {
        if (chunk.type === 'text') {
          accumulated += chunk.delta as string
          setOutput(accumulated)
        } else if (chunk.type === 'status') {
          setStatus(chunk.text as string)
        }
      }
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === 'AbortError')) {
        setStatus(e instanceof Error ? e.message : 'Request failed.')
      }
    } finally {
      setStatus('')
      setRunning(false)
      abortRef.current = null
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaveError('')
    try {
      const data = {
        name: name.trim(),
        description: description.trim() || undefined,
        promptText,
        suggestedMode: mode,
      }
      let saved: CustomTemplate
      if (initial) {
        await updateCustomTemplate(initial.id, data)
        saved = { ...initial, ...data }
      } else {
        saved = await createCustomTemplate(data)
      }
      onSave(saved)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  return (
    <Modal title={initial ? 'Edit template' : 'New template'} onClose={onClose} maxWidth="max-w-4xl">
      <div className="flex flex-col gap-4">

        {/* Editor + Output */}
        <div className="grid gap-4 md:grid-cols-2">

          {/* Editor */}
          <div className="flex flex-col gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Prompt text</label>
              <p className="text-xs text-gray-500 mb-1.5">
                Use <code className="text-gray-400 bg-gray-800 px-1 rounded">{'{{field}}'}</code> for placeholders — they become input fields when using the template.
              </p>
              <textarea
                value={promptText}
                onChange={e => setPromptText(e.target.value)}
                rows={8}
                className="w-full rounded bg-gray-800 border border-gray-700 px-2.5 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 resize-y font-mono"
                placeholder={'Explain {{concept}} to a {{audience}} in under {{words}} words.'}
              />
            </div>

            {fields.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-gray-400 font-medium">Test values</p>
                {fields.map(f => (
                  <div key={f}>
                    <label className="block text-xs text-gray-500 mb-0.5">{fieldLabel(f)}</label>
                    <input
                      type="text"
                      value={fieldValues[f] ?? ''}
                      onChange={e => setFieldValues(prev => ({ ...prev, [f]: e.target.value }))}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                      placeholder={`{{${f}}}`}
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={mode}
                onChange={e => setMode(e.target.value as FocusMode)}
                className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
              >
                {MODE_OPTIONS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <button
                type="button"
                onClick={handleRun}
                disabled={!canRun}
                className="px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 disabled:opacity-40 text-sm font-medium transition-colors"
              >
                {running ? 'Running…' : '▶ Run'}
              </button>
              {running && (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-300 transition-colors"
                >
                  Stop
                </button>
              )}
            </div>
          </div>

          {/* Output */}
          <div className="flex flex-col gap-1">
            <p className="text-xs text-gray-400">Output</p>
            {status && <p className="text-xs text-blue-400 italic">{status}</p>}
            <div className="rounded bg-gray-800 border border-gray-700 p-2.5 text-sm text-gray-300 min-h-[14rem] max-h-[26rem] overflow-y-auto whitespace-pre-wrap">
              {output || <span className="text-gray-600 italic">Run to see output here…</span>}
            </div>
          </div>
        </div>

        {/* Save */}
        <div className="border-t border-gray-800 pt-4 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Template name <span className="text-blue-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={100}
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                placeholder="e.g. Explain concept"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Description</label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                maxLength={200}
                className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                placeholder="Short description (optional)"
              />
            </div>
          </div>
          {saveError && <p className="text-xs text-red-400">{saveError}</p>}
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="self-start px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm font-medium transition-colors"
          >
            {saving ? 'Saving…' : initial ? 'Update template' : 'Save template'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
