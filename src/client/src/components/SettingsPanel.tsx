import { useState, type FormEvent } from 'react'
import { updateSettings } from '../lib/api.ts'

const FONT_SIZES = [
  { label: 'Small', value: 14 },
  { label: 'Normal', value: 16 },
  { label: 'Large', value: 18 },
  { label: 'XL', value: 20 },
]

interface Props {
  customPrompt: string
  showThinking: { balanced: boolean; thorough: boolean }
  useThinking: boolean
  fontSize: number
  onClose: () => void
  onSave: (customPrompt: string, showThinking: { balanced: boolean; thorough: boolean }, useThinking: boolean, fontSize: number) => void
}

export function SettingsPanel({ customPrompt: initial, showThinking: initialShowThinking, useThinking: initialUseThinking, fontSize: initialFontSize, onClose, onSave }: Props) {
  const [customPrompt, setCustomPrompt] = useState(initial)
  const [showThinking, setShowThinking] = useState(initialShowThinking)
  const [useThinking, setUseThinking] = useState(initialUseThinking)
  const [fontSize, setFontSize] = useState(initialFontSize)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await updateSettings({ customPrompt, showThinking, useThinking, fontSize })
      onSave(customPrompt, showThinking, useThinking, fontSize)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl p-6 w-full max-w-md flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-100">Settings</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400 font-medium">Custom system prompt</label>
            <p className="text-xs text-gray-500">
              Appended to the assistant's instructions for every query.
            </p>
            <textarea
              rows={5}
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              placeholder="e.g. Always respond in Swedish. Prefer academic sources."
              className="mt-1 px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 resize-none focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">Show search process</label>
            <p className="text-xs text-gray-500">Display search queries and result snippets in a collapsed block before the answer.</p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showThinking.balanced}
                onChange={e => setShowThinking(t => ({ ...t, balanced: e.target.checked }))}
                className="accent-blue-500"
              />
              Balanced mode
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showThinking.thorough}
                onChange={e => setShowThinking(t => ({ ...t, thorough: e.target.checked }))}
                className="accent-blue-500"
              />
              Thorough mode
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">Model thinking (thorough mode)</label>
            <p className="text-xs text-gray-500">
              Uses the <code className="text-gray-400">THINKING_MODEL</code> for the research phase (falls back to the chat model if not configured). Requires a reasoning-capable model (e.g. Qwen3).
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useThinking}
                onChange={e => setUseThinking(e.target.checked)}
                className="accent-blue-500"
              />
              Enable model thinking
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">Font size</label>
            <div className="flex gap-2">
              {FONT_SIZES.map(({ label, value }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFontSize(value)}
                  className={`px-3 py-1 rounded text-sm ${fontSize === value ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-1.5 rounded text-sm text-gray-400 hover:text-gray-200">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium"
            >
              {saved ? 'Saved!' : busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
