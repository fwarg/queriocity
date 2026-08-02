import { useState, type FormEvent } from 'react'
import { updateSettings, changePassword } from '../lib/api.ts'
import { Modal } from './Modal.tsx'

const FONT_SIZES = [
  { label: 'Small', value: 15 },
  { label: 'Normal', value: 17 },
  { label: 'Large', value: 19 },
  { label: 'XL', value: 21 },
]

const TIMEZONE_OPTIONS = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Stockholm',
  'Europe/Helsinki', 'Europe/Moscow', 'Europe/Istanbul',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland',
]

/** The settings this panel owns. Passed and returned as one object rather than as positional
 *  arguments — five of the eight fields are booleans, and transposing two of those silently
 *  swaps unrelated features. */
export interface UserSettingsForm {
  customPrompt: string
  showThinking: { balanced: boolean; thorough: boolean }
  useThinking: boolean
  useSpaceRag: boolean
  useChatRag: boolean
  querySuggestions: boolean
  followUpSuggestions: boolean
  fontSize: number
  timezone: string
}

interface Props extends UserSettingsForm {
  onClose: () => void
  /** Clears the temporary-password banner once the user has set their own. */
  onPasswordChanged?: () => void
  onSave: (settings: UserSettingsForm) => void
}

export function SettingsPanel({ customPrompt: initial, showThinking: initialShowThinking, useThinking: initialUseThinking, useSpaceRag: initialUseSpaceRag, useChatRag: initialUseChatRag, querySuggestions: initialQuerySuggestions, followUpSuggestions: initialFollowUpSuggestions, fontSize: initialFontSize, timezone: initialTimezone, onClose, onPasswordChanged, onSave }: Props) {
  const [customPrompt, setCustomPrompt] = useState(initial)
  const [showThinking, setShowThinking] = useState(initialShowThinking)
  const [useThinking, setUseThinking] = useState(initialUseThinking)
  const [useSpaceRag, setUseSpaceRag] = useState(initialUseSpaceRag)
  const [useChatRag, setUseChatRag] = useState(initialUseChatRag)
  const [querySuggestions, setQuerySuggestions] = useState(initialQuerySuggestions)
  const [followUpSuggestions, setFollowUpSuggestions] = useState(initialFollowUpSuggestions)
  const [fontSize, setFontSize] = useState(initialFontSize)
  const [timezone, setTimezone] = useState(initialTimezone)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState('')
  const [passwordOk, setPasswordOk] = useState(false)

  async function handleChangePassword() {
    setPwBusy(true)
    setPasswordMsg('')
    try {
      await changePassword(currentPassword, newPassword)
      setPasswordOk(true)
      setPasswordMsg('Password changed.')
      onPasswordChanged?.()
      setCurrentPassword('')
      setNewPassword('')
    } catch (e) {
      setPasswordOk(false)
      setPasswordMsg(e instanceof Error ? e.message : 'Could not change password')
    } finally {
      setPwBusy(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const form = { customPrompt, showThinking, useThinking, useSpaceRag, useChatRag, querySuggestions, followUpSuggestions, fontSize, timezone }
      await updateSettings({ ...form, timezone: timezone || undefined })
      onSave(form)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Settings" onClose={onClose}>
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
            <label className="text-xs text-gray-400 font-medium">Space RAG</label>
            <p className="text-xs text-gray-500">
              When chatting in a space, retrieve relevant memories and document excerpts based on your query (in addition to the fixed memory block).
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useSpaceRag}
                onChange={e => setUseSpaceRag(e.target.checked)}
                className="accent-blue-500"
              />
              Enable space RAG
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">Chat RAG</label>
            <p className="text-xs text-gray-500">
              When chatting outside a space, automatically retrieve relevant excerpts from your uploaded files and inject them into the context.
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useChatRag}
                onChange={e => setUseChatRag(e.target.checked)}
                className="accent-blue-500"
              />
              Enable chat RAG
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">Query suggestions</label>
            <p className="text-xs text-gray-500">
              Show AI-generated query completions as you type in the chat input. Adds a small flash-model call on each keystroke pause — disable on slow setups.
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={querySuggestions}
                onChange={e => setQuerySuggestions(e.target.checked)}
                className="accent-blue-500"
              />
              Enable query suggestions
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">Follow-up suggestions</label>
            <p className="text-xs text-gray-500">
              Show up to three suggested follow-up questions as chips under a finished answer. Adds one flash-model call per answer — disable on slow setups.
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={followUpSuggestions}
                onChange={e => setFollowUpSuggestions(e.target.checked)}
                className="accent-blue-500"
              />
              Enable follow-up suggestions
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
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">Timezone</label>
            <p className="text-xs text-gray-500">Used for scheduling monitors at a specific hour of the day.</p>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="">Not set (server default)</option>
              {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">Password</label>
            <p className="text-xs text-gray-500">
              At least 8 characters with upper and lower case, a digit and a symbol. Changing it
              signs out your other devices.
            </p>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="New password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
            />
            {passwordMsg && (
              <p className={`text-xs ${passwordOk ? 'text-green-400' : 'text-red-400'}`}>{passwordMsg}</p>
            )}
            <button
              type="button"
              onClick={handleChangePassword}
              disabled={pwBusy || !currentPassword || !newPassword}
              className="self-start px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-50 text-sm"
            >
              {pwBusy ? 'Changing…' : 'Change password'}
            </button>
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
    </Modal>
  )
}
