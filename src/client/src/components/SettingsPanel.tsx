import { useState, useEffect, type FormEvent } from 'react'
import { Trash2, X } from 'lucide-react'
import { RowAction } from './ui.tsx'
import {
  updateSettings, changePassword,
  fetchUserMemories, createUserMemory, updateUserMemory, deleteUserMemory, suggestUserMemories,
  type UserMemory,
} from '../lib/api.ts'
import { Modal } from './Modal.tsx'
import { LanguageSelect } from './LanguageSelect.tsx'
import { useLang, useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import type { Lang, TranslationKey } from '@shared/i18n/index.ts'
import { GuideLink } from './GuideView.tsx'

/** Inline CRUD for the user-level memory list. Kept in this panel because these facts are
 *  account-wide — there is no space to hang them off. */
function UserMemoryList() {
  const t = useT()
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
    setScanStatus(t('userMemory.scanning'))
    try {
      for await (const ev of suggestUserMemories(scanDepth)) {
        if (ev.processing && ev.total) setScanStatus(t('userMemory.scanProgress', { index: ev.processing, total: ev.total }))
        if (ev.done) {
          setSuggestions(ev.suggestions ?? [])
          setScanStatus(ev.error ?? (ev.suggestions?.length ? '' : t('userMemory.nothingFound')))
        }
      }
    } catch {
      setScanStatus(t('userMemory.scanFailed'))
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
        placeholder={t('userMemory.addPlaceholder')}
        className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
      />
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={runSuggest}
          disabled={scanning}
          className="text-xs text-blue-400 hover:text-blue-300 disabled:text-gray-600"
        >
          {scanning ? t('userMemory.scanningShort') : t('userMemory.suggest')}
        </button>
        <select
          value={scanDepth}
          onChange={e => setScanDepth(Number(e.target.value))}
          disabled={scanning}
          title={t('userMemory.scanDepthTitle')}
          className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-[11px] text-gray-300 focus:outline-none focus:border-blue-500 disabled:text-gray-600"
        >
          {[20, 50, 100, 200].map(n => (
            <option key={n} value={n}>{t('userMemory.scanDepth', { count: n })}</option>
          ))}
        </select>
        {scanStatus && <span className="text-[11px] text-gray-500">{scanStatus}</span>}
      </div>
      {suggestions.length > 0 && (
        <div className="rounded border border-gray-700 bg-gray-800/40 p-2 flex flex-col gap-1">
          <p className="text-[11px] text-gray-500">
            {t('userMemory.proposed')}
          </p>
          {suggestions.map(fact => (
            <div key={fact} className="flex items-start gap-1.5">
              <span className="flex-1 text-xs text-gray-300">{fact}</span>
              <button
                type="button"
                onClick={() => accept(fact)}
                className="text-xs text-green-400 hover:text-green-300 shrink-0"
                aria-label={t('common.add')}
              >
                + Add
              </button>
              <RowAction
                icon={<X size={14} />}
                persistent
                label={t('common.dismiss')}
                onClick={() => setSuggestions(prev => prev.filter(f => f !== fact))}
              />
            </div>
          ))}
        </div>
      )}
      {memories.length === 0 && (
        <p className="text-xs text-gray-600">{t('userMemory.none')}</p>
      )}
      {memories.map(m => (
        <div key={m.id} className="flex items-start gap-1.5 group py-0.5">
          <button
            type="button"
            onClick={() => toggleKeep(m)}
            className={`shrink-0 text-xs leading-none mt-0.5 ${m.alwaysKeep ? 'text-amber-400' : 'text-gray-700 hover:text-gray-500 md:opacity-0 md:group-hover:opacity-100'}`}
            title={t(m.alwaysKeep ? 'userMemory.alwaysIncludedTitle' : 'userMemory.alwaysIncludeTitle')}
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
          <span className="text-[10px] text-gray-600 shrink-0 mt-0.5">{t(m.source === 'tool' ? 'memory.sourceAuto' : 'memory.sourceManual')}</span>
          <RowAction
            icon={<Trash2 size={14} />}
            tone="danger"
            label={t('common.delete')}
            onClick={() => remove(m.id)}
          />
        </div>
      ))}
    </div>
  )
}

const FONT_SIZES: Array<{ labelKey: TranslationKey; value: number }> = [
  { labelKey: 'settings.fontSmall', value: 15 },
  { labelKey: 'settings.fontNormal', value: 17 },
  { labelKey: 'settings.fontLarge', value: 19 },
  { labelKey: 'settings.fontXl', value: 21 },
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
  imageWatermark: boolean
  fontSize: number
  timezone: string
  language: Lang
}

/** `language` is omitted: the selector writes straight to the language provider so the switch is
 *  visible immediately, and Save persists whatever it currently holds. Passing it in as well would
 *  give the same value two owners. */
interface Props extends Omit<UserSettingsForm, 'language'> {
  onClose: () => void
  /** Clears the temporary-password banner once the user has set their own. */
  onPasswordChanged?: () => void
  onSave: (settings: UserSettingsForm) => void
}

export function SettingsPanel({ customPrompt: initial, showThinking: initialShowThinking, useThinking: initialUseThinking, useSpaceRag: initialUseSpaceRag, useChatRag: initialUseChatRag, querySuggestions: initialQuerySuggestions, followUpSuggestions: initialFollowUpSuggestions, userMemory: initialUserMemory, imageWatermark: initialImageWatermark, fontSize: initialFontSize, timezone: initialTimezone, onClose, onPasswordChanged, onSave }: Props) {
  const t = useT()
  const { lang, setLang } = useLang()
  const [customPrompt, setCustomPrompt] = useState(initial)
  const [showThinking, setShowThinking] = useState(initialShowThinking)
  const [useThinking, setUseThinking] = useState(initialUseThinking)
  const [useSpaceRag, setUseSpaceRag] = useState(initialUseSpaceRag)
  const [useChatRag, setUseChatRag] = useState(initialUseChatRag)
  const [querySuggestions, setQuerySuggestions] = useState(initialQuerySuggestions)
  const [followUpSuggestions, setFollowUpSuggestions] = useState(initialFollowUpSuggestions)
  const [userMemory, setUserMemory] = useState(initialUserMemory)
  const [imageWatermark, setImageWatermark] = useState(initialImageWatermark)
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
      setPasswordMsg(t('settings.passwordChanged'))
      onPasswordChanged?.()
      setCurrentPassword('')
      setNewPassword('')
    } catch (e) {
      setPasswordOk(false)
      setPasswordMsg(errorMessage(t, e, t('settings.passwordChangeFailed')))
    } finally {
      setPwBusy(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const form = { customPrompt, showThinking, useThinking, useSpaceRag, useChatRag, querySuggestions, followUpSuggestions, userMemory, imageWatermark, fontSize, timezone, language: lang }
      await updateSettings({ ...form, timezone: timezone || undefined })
      onSave(form)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('nav.settings')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400 font-medium">{t('settings.customPrompt')}</label>
            <p className="text-xs text-gray-500">{t('settings.customPromptDesc')}</p>
            <textarea
              rows={5}
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              placeholder={t('settings.customPromptPlaceholder')}
              className="mt-1 px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 resize-none focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.showProcess')}</label>
            <p className="text-xs text-gray-500">{t('settings.showProcessDesc')}</p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showThinking.balanced}
                onChange={e => setShowThinking(t => ({ ...t, balanced: e.target.checked }))}
                className="accent-blue-500"
              />
              {t('settings.balancedMode')}
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showThinking.thorough}
                onChange={e => setShowThinking(t => ({ ...t, thorough: e.target.checked }))}
                className="accent-blue-500"
              />
              {t('settings.thoroughMode')}
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.thinking')}</label>
            <p className="text-xs text-gray-500">{t('settings.thinkingDesc')}</p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useThinking}
                onChange={e => setUseThinking(e.target.checked)}
                className="accent-blue-500"
              />
              {t('settings.thinkingEnable')}
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.spaceRag')}</label>
            <p className="text-xs text-gray-500">{t('settings.spaceRagDesc')}</p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useSpaceRag}
                onChange={e => setUseSpaceRag(e.target.checked)}
                className="accent-blue-500"
              />
              {t('settings.spaceRagEnable')}
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.chatRag')}</label>
            <p className="text-xs text-gray-500">{t('settings.chatRagDesc')}</p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useChatRag}
                onChange={e => setUseChatRag(e.target.checked)}
                className="accent-blue-500"
              />
              {t('settings.chatRagEnable')}
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.querySuggestions')}</label>
            <p className="text-xs text-gray-500">{t('settings.querySuggestionsDesc')}</p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={querySuggestions}
                onChange={e => setQuerySuggestions(e.target.checked)}
                className="accent-blue-500"
              />
              {t('settings.querySuggestionsEnable')}
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.followUpSuggestions')}</label>
            <p className="text-xs text-gray-500">{t('settings.followUpSuggestionsDesc')}</p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={followUpSuggestions}
                onChange={e => setFollowUpSuggestions(e.target.checked)}
                className="accent-blue-500"
              />
              {t('settings.followUpSuggestionsEnable')}
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.aboutYou')}</label>
            <p className="text-xs text-gray-500">{t('settings.aboutYouDesc')} <GuideLink topic="settings" /></p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={userMemory}
                onChange={e => setUserMemory(e.target.checked)}
                className="accent-blue-500"
              />
              {t('settings.aboutYouEnable')}
            </label>
            {userMemory && <UserMemoryList />}
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.imageLabelling')}</label>
            <p className="text-xs text-gray-500">{t('settings.imageLabellingDesc')}</p>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={imageWatermark}
                onChange={e => setImageWatermark(e.target.checked)}
                className="accent-blue-500"
              />
              {t('settings.imageLabellingEnable')}
            </label>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.language')}</label>
            <LanguageSelect value={lang} onChange={setLang} className="self-start" />
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.fontSize')}</label>
            <div className="flex gap-2">
              {FONT_SIZES.map(({ labelKey, value }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFontSize(value)}
                  className={`px-3 py-1 rounded text-sm ${fontSize === value ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.timezone')}</label>
            <p className="text-xs text-gray-500">{t('settings.timezoneDesc')}</p>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="">{t('settings.timezoneUnset')}</option>
              {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 font-medium">{t('settings.password')}</label>
            <p className="text-xs text-gray-500">{t('settings.passwordDesc')}</p>
            <input
              type="password"
              autoComplete="current-password"
              placeholder={t('settings.currentPassword')}
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              className="rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder={t('settings.newPassword')}
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
              {pwBusy ? t('settings.changingPassword') : t('settings.changePassword')}
            </button>
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-1.5 rounded text-sm text-gray-400 hover:text-gray-200">
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium"
            >
              {saved ? t('common.saved') : busy ? t('common.saving') : t('common.save')}
            </button>
          </div>
      </form>
    </Modal>
  )
}
