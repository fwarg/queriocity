import { useState, useEffect, type FormEvent } from 'react'
import {
  updateSettings, changePassword,
  fetchUserMemories, createUserMemory, updateUserMemory, deleteUserMemory, suggestUserMemories,
  type UserMemory,
} from '../lib/api.ts'
import { Modal } from './Modal.tsx'

/** Inline CRUD for the user-level memory list. Kept in this panel because these facts are
 *  account-wide — there is no space to hang them off. */
function UserMemoryList() {
  const [memories, setMemories] = useState<UserMemory[]>([])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [scanDepth, setScanDepth] = useState(20)

  useEffect(() => { fetchUserMemories().then(r => setMemories(r.memories)).catch(() => {}) }, [])

  async function runSuggest() {
    setScanning(true)
    setSuggestions([])
    setScanStatus('Reading recent chats…')
    try {
      for await (const ev of suggestUserMemories(scanDepth)) {
        if (ev.processing && ev.total) setScanStatus(`Reading chat ${ev.processing} of ${ev.total}…`)
        if (ev.done) {
          setSuggestions(ev.suggestions ?? [])
          setScanStatus(ev.error ?? (ev.suggestions?.length ? '' : 'Nothing worth saving found.'))
        }
      }
    } catch {
      setScanStatus('Suggestion scan failed.')
    } finally {
      setScanning(false)
    }
  }

  function accept(fact: string) {
    setSuggestions(prev => prev.filter(f => f !== fact))
    createUserMemory(fact).then(m => setMemories(prev => [m, ...prev])).catch(() => {})
  }

  function add() {
    const content = draft.trim()
    setDraft('')
    if (!content) return
    createUserMemory(content).then(m => setMemories(prev => [m, ...prev])).catch(() => {})
  }

  function saveEdit(id: string) {
    const content = editDraft.trim()
    setEditingId(null)
    if (!content) return
    setMemories(prev => prev.map(m => m.id === id ? { ...m, content } : m))
    updateUserMemory(id, { content }).catch(() => {})
  }

  function toggleKeep(m: UserMemory) {
    setMemories(prev => prev.map(x => x.id === m.id ? { ...x, alwaysKeep: !m.alwaysKeep } : x))
    updateUserMemory(m.id, { alwaysKeep: !m.alwaysKeep }).catch(() => {})
  }

  function remove(id: string) {
    setMemories(prev => prev.filter(m => m.id !== id))
    deleteUserMemory(id).catch(() => {})
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        onBlur={add}
        placeholder="Add a fact about you…"
        className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
      />
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={runSuggest}
          disabled={scanning}
          className="text-xs text-blue-400 hover:text-blue-300 disabled:text-gray-600"
        >
          {scanning ? 'Scanning…' : 'Suggest from my chats'}
        </button>
        <select
          value={scanDepth}
          onChange={e => setScanDepth(Number(e.target.value))}
          disabled={scanning}
          title="How many of your most recent chats to read. One model call each, so a deeper scan takes proportionally longer."
          className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-[11px] text-gray-300 focus:outline-none focus:border-blue-500 disabled:text-gray-600"
        >
          {[20, 50, 100, 200].map(n => (
            <option key={n} value={n}>last {n} chats</option>
          ))}
        </select>
        {scanStatus && <span className="text-[11px] text-gray-500">{scanStatus}</span>}
      </div>
      {suggestions.length > 0 && (
        <div className="rounded border border-gray-700 bg-gray-800/40 p-2 flex flex-col gap-1">
          <p className="text-[11px] text-gray-500">
            Proposed from your recent chats — nothing is saved until you add it.
          </p>
          {suggestions.map(fact => (
            <div key={fact} className="flex items-start gap-1.5">
              <span className="flex-1 text-xs text-gray-300">{fact}</span>
              <button
                type="button"
                onClick={() => accept(fact)}
                className="text-xs text-green-400 hover:text-green-300 shrink-0"
                aria-label="Add"
              >
                + Add
              </button>
              <button
                type="button"
                onClick={() => setSuggestions(prev => prev.filter(f => f !== fact))}
                className="text-xs text-gray-600 hover:text-gray-400 shrink-0"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {memories.length === 0 && (
        <p className="text-xs text-gray-600">Nothing saved yet.</p>
      )}
      {memories.map(m => (
        <div key={m.id} className="flex items-start gap-1.5 group py-0.5">
          <button
            type="button"
            onClick={() => toggleKeep(m)}
            className={`shrink-0 text-xs leading-none mt-0.5 ${m.alwaysKeep ? 'text-amber-400' : 'text-gray-700 hover:text-gray-500 opacity-0 group-hover:opacity-100'}`}
            title={m.alwaysKeep ? 'Always included. Click to unset.' : 'Always include this one'}
            aria-pressed={m.alwaysKeep}
          >
            {m.alwaysKeep ? '★' : '☆'}
          </button>
          {editingId === m.id ? (
            <input
              autoFocus
              type="text"
              value={editDraft}
              onChange={e => setEditDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(m.id) } if (e.key === 'Escape') setEditingId(null) }}
              onBlur={() => saveEdit(m.id)}
              className="flex-1 px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
            />
          ) : (
            <span
              onClick={() => { setEditDraft(m.content); setEditingId(m.id) }}
              className="flex-1 text-xs text-gray-300 cursor-pointer hover:text-gray-100"
            >
              {m.content}
            </span>
          )}
          <span className="text-[10px] text-gray-600 shrink-0 mt-0.5">{m.source === 'tool' ? 'auto' : 'manual'}</span>
          <button
            type="button"
            onClick={() => remove(m.id)}
            className="text-gray-700 hover:text-red-400 text-xs shrink-0 opacity-0 group-hover:opacity-100"
            aria-label="Delete"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

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
  userMemory: boolean
  fontSize: number
  timezone: string
}

interface Props extends UserSettingsForm {
  onClose: () => void
  /** Clears the temporary-password banner once the user has set their own. */
  onPasswordChanged?: () => void
  onSave: (settings: UserSettingsForm) => void
}

export function SettingsPanel({ customPrompt: initial, showThinking: initialShowThinking, useThinking: initialUseThinking, useSpaceRag: initialUseSpaceRag, useChatRag: initialUseChatRag, querySuggestions: initialQuerySuggestions, followUpSuggestions: initialFollowUpSuggestions, userMemory: initialUserMemory, fontSize: initialFontSize, timezone: initialTimezone, onClose, onPasswordChanged, onSave }: Props) {
  const [customPrompt, setCustomPrompt] = useState(initial)
  const [showThinking, setShowThinking] = useState(initialShowThinking)
  const [useThinking, setUseThinking] = useState(initialUseThinking)
  const [useSpaceRag, setUseSpaceRag] = useState(initialUseSpaceRag)
  const [useChatRag, setUseChatRag] = useState(initialUseChatRag)
  const [querySuggestions, setQuerySuggestions] = useState(initialQuerySuggestions)
  const [followUpSuggestions, setFollowUpSuggestions] = useState(initialFollowUpSuggestions)
  const [userMemory, setUserMemory] = useState(initialUserMemory)
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
      const form = { customPrompt, showThinking, useThinking, useSpaceRag, useChatRag, querySuggestions, followUpSuggestions, userMemory, fontSize, timezone }
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
            <label className="text-xs text-gray-400 font-medium">About you</label>
            <p className="text-xs text-gray-500">
              Facts that apply to every chat, not just one space — how you want answers written, languages you work in, lasting constraints. Nothing is added automatically: you write these, or the assistant asks to. Space memory wins where the two disagree.
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={userMemory}
                onChange={e => setUserMemory(e.target.checked)}
                className="accent-blue-500"
              />
              Enable memory about me
            </label>
            {userMemory && <UserMemoryList />}
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
