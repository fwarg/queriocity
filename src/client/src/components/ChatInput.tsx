import { useEffect, useState, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { Send, Paperclip, X, Square, LayoutGrid, ChevronDown, ChevronUp, NotebookPen } from 'lucide-react'
import { AI_SYSTEM_NOTICE_SHORT } from '../lib/ai-notice.ts'
import { extractFileForContext, fetchFiles, fetchNoteText, fetchSuggestions, type Resource } from '../lib/api.ts'
import { Modal } from './Modal.tsx'
import { TemplateSelector } from './TemplateSelector.tsx'
import { useT } from '../lib/i18n.tsx'
import type { TranslationKey } from '@shared/i18n/index.ts'

type FocusMode = 'flash' | 'balanced' | 'thorough' | 'image'
type SearchCategory = 'news' | 'science' | 'discussions' | 'tech'

const SEARCH_CATEGORIES: SearchCategory[] = ['news', 'science', 'discussions', 'tech']

interface Props {
  onSubmit: (text: string) => void
  onCancel?: () => void
  disabled?: boolean
  focusMode: FocusMode
  onFocusModeChange: (m: FocusMode) => void
  searchCategories: SearchCategory[]
  onSearchCategoriesChange: (cats: SearchCategory[]) => void
  suggestionsEnabled?: boolean
  /** The chat's space is locked: no web search, URL fetching or image generation. Advisory only —
   *  the server enforces it — but the controls should not offer what will be refused. */
  lockedSpace?: boolean
  /** Follow-up questions for the last answer. Rendered here rather than above the input so they
   *  collapse with it — on a phone they otherwise eat the message list. */
  related?: string[]
  onRelatedSelect?: (question: string) => void
}

interface Attachment {
  filename: string
  content: string
}

const FLASH_MAX = 200

/** One key per mode, so the description and the button label move together in a new catalog. */
const MODE_DESCRIPTION_KEYS: Record<FocusMode, TranslationKey> = {
  flash: 'mode.flashDesc',
  balanced: 'mode.balancedDesc',
  thorough: 'mode.thoroughDesc',
  image: 'mode.imageDesc',
}
const MODE_LABEL_KEYS: Record<FocusMode, TranslationKey> = {
  flash: 'mode.flash',
  balanced: 'mode.balanced',
  thorough: 'mode.thorough',
  image: 'mode.image',
}
const CATEGORY_LABEL_KEYS: Record<SearchCategory, TranslationKey> = {
  news: 'category.news',
  science: 'category.science',
  discussions: 'category.discussions',
  tech: 'category.tech',
}

export function ChatInput({ onSubmit, onCancel, disabled, focusMode, onFocusModeChange, searchCategories, onSearchCategoriesChange, suggestionsEnabled, lockedSpace = false, related = [], onRelatedSelect }: Props) {
  const t = useT()
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [extractStatus, setExtractStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [extractError, setExtractError] = useState('')
  const [pickingNote, setPickingNote] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [visibleDesc, setVisibleDesc] = useState<TranslationKey | null>(null)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const descTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleModeChange(m: FocusMode) {
    onFocusModeChange(m)
    if (descTimerRef.current) clearTimeout(descTimerRef.current)
    setVisibleDesc(MODE_DESCRIPTION_KEYS[m])
    descTimerRef.current = setTimeout(() => setVisibleDesc(null), 2500)
  }

  const isFlash = focusMode === 'flash'
  const isOverLimit = isFlash && value.length > FLASH_MAX

  function handleSuggestionFetch(text: string) {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    if (!suggestionsEnabled || focusMode === 'flash' || text.trim().length < 8) {
      setSuggestions([])
      return
    }
    suggestTimerRef.current = setTimeout(async () => {
      try {
        const results = await fetchSuggestions(text.trim())
        setSuggestions(results)
      } catch { setSuggestions([]) }
    }, 500)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const text = value.trim()
    if ((!text && attachments.length === 0) || disabled || isOverLimit) return

    let fullText = text
    for (const att of attachments) {
      fullText += `\n\n---\n[${att.filename}]\n${att.content}`
    }

    onSubmit(fullText)
    setValue('')
    setAttachments([])
    setSuggestions([])
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e as unknown as FormEvent)
    }
  }

  async function attachNote(id: string) {
    setPickingNote(false)
    setExtractStatus('loading')
    setExtractError('')
    try {
      const note = await fetchNoteText(id)
      setAttachments(prev => [...prev, note])
      setExtractStatus('idle')
    } catch (err: unknown) {
      setExtractStatus('error')
      setExtractError(err instanceof Error ? err.message : t('input.readFileFailed'))
      setTimeout(() => setExtractStatus('idle'), 4000)
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setExtractStatus('loading')
    setExtractError('')
    try {
      const att = await extractFileForContext(file)
      setAttachments(prev => [...prev, att])
      setExtractStatus('idle')
    } catch (err: unknown) {
      setExtractStatus('error')
      setExtractError(err instanceof Error ? err.message : t('input.readFileFailed'))
      setTimeout(() => setExtractStatus('idle'), 4000)
    } finally {
      e.target.value = ''
    }
  }

  return (
    <form onSubmit={handleSubmit} className="relative flex flex-col border-t border-gray-800">
      <button
        type="button"
        onClick={() => setCollapsed(v => !v)}
        className="flex justify-center py-1 text-gray-700 hover:text-gray-400 transition-colors"
        aria-label={t(collapsed ? 'input.expand' : 'input.collapse')}
      >
        {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {/* max-h is the transition target, not a layout budget — it must clear the tallest case
          (follow-up chips wrapping to several lines on a phone) or overflow-hidden clips it. */}
      <div className={`overflow-hidden transition-all duration-300 flex flex-col gap-2 px-4 ${collapsed ? 'max-h-0' : 'max-h-[34rem] pb-4'}`}>
      {showTemplates && (
        <TemplateSelector
          onSelect={(text, mode) => {
            setValue(text)
            onFocusModeChange(mode)
            setShowTemplates(false)
          }}
          onClose={() => setShowTemplates(false)}
        />
      )}
      <div className={`overflow-hidden text-xs text-gray-500 flex items-center transition-all duration-500 ${visibleDesc ? 'max-h-7 opacity-100' : 'max-h-0 opacity-0'}`}>
        {visibleDesc && t(visibleDesc)}
      </div>
      <div className="flex items-center gap-2 text-xs">
        {(['flash', 'balanced', 'thorough', 'image'] as const).map(m => {
          // Image generation sends the prompt to the diffusion server, which is egress like any
          // other, so a locked space refuses it. Disabled rather than hidden to keep the row stable.
          const blocked = lockedSpace && m === 'image'
          return (
            <button
              key={m}
              type="button"
              disabled={blocked}
              onClick={() => handleModeChange(m)}
              title={blocked ? t('mode.blockedLocked') : undefined}
              className={`px-2 py-1 rounded capitalize ${focusMode === m ? 'bg-blue-600' : blocked ? 'bg-gray-800/50 text-gray-600 cursor-not-allowed' : 'bg-gray-800 hover:bg-gray-700'}`}
            >
              {t(MODE_LABEL_KEYS[m])}
            </button>
          )
        })}
        <span className="flex-1" />
        {isFlash && (
          <span className={isOverLimit ? 'text-red-400' : 'text-gray-500'}>
            {value.length}/{FLASH_MAX}
          </span>
        )}
        {!lockedSpace && (focusMode === 'balanced' || focusMode === 'thorough') && (
          <button
            type="button"
            onClick={() => setCategoryOpen(o => !o)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${searchCategories.length > 0 ? 'bg-indigo-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {searchCategories.length === 0 ? t('category.all') : searchCategories.map(c => t(CATEGORY_LABEL_KEYS[c])).join('+')}
            <span className="opacity-60">{categoryOpen ? '▴' : '▾'}</span>
          </button>
        )}
      </div>
      {categoryOpen && !lockedSpace && (focusMode === 'balanced' || focusMode === 'thorough') && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {SEARCH_CATEGORIES.map(cat => (
            <button
              key={cat}
              type="button"
              onClick={() => {
                const next = searchCategories.includes(cat)
                  ? searchCategories.filter(c => c !== cat)
                  : [...searchCategories, cat]
                onSearchCategoriesChange(next)
              }}
              className={`px-2 py-0.5 rounded capitalize text-xs ${searchCategories.includes(cat) ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'}`}
            >
              {t(CATEGORY_LABEL_KEYS[cat])}
            </button>
          ))}
        </div>
      )}
      {related.length > 0 && !disabled && (
        <div className="flex flex-wrap gap-1.5">
          {related.map((q, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onRelatedSelect?.(q)}
              className="rounded-full border border-gray-700 bg-gray-800/60 px-2.5 py-1 text-xs text-left text-gray-300 hover:border-gray-600 hover:text-gray-100"
            >
              {q}
            </button>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => { setValue(s); setSuggestions([]) }}
              className="px-2 py-0.5 rounded-full text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white border border-gray-600 truncate max-w-60"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((att, i) => (
            <div key={i} className="flex items-center gap-1 px-2 py-1 rounded bg-gray-700 text-xs text-gray-200">
              <Paperclip size={10} className="shrink-0 text-gray-400" />
              <span className="truncate max-w-40">{att.filename}</span>
              <button
                type="button"
                onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                className="text-gray-400 hover:text-white ml-0.5"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {extractStatus === 'loading' && (
        <div className="text-xs text-gray-400 animate-pulse">{t('input.readingFile')}</div>
      )}
      {extractStatus === 'error' && (
        <div className="text-xs text-red-400">{extractError}</div>
      )}
      <div className="flex gap-2">
        <textarea
          className="flex-1 resize-none rounded bg-gray-900 border border-gray-700 p-2 text-sm focus:outline-none focus:border-blue-500"
          rows={3}
          value={value}
          onChange={e => { setValue(e.target.value); handleSuggestionFetch(e.target.value) }}
          onKeyDown={handleKey}
          placeholder={t('input.placeholder')}
          disabled={disabled}
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowTemplates(v => !v)}
            className={`p-2 rounded ${showTemplates ? 'bg-blue-700 hover:bg-blue-600' : 'bg-gray-800 hover:bg-gray-700'}`}
            title={t('input.templateTitle')}
            aria-label={t('input.templates')}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={isFlash || extractStatus === 'loading'}
            className="p-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
            title={t(isFlash ? 'input.attachBlockedFlash' : 'input.attachTitle')}
            aria-label={t(isFlash ? 'input.attachBlockedFlashLabel' : 'input.attach')}
          >
            <Paperclip size={16} className={extractStatus === 'loading' ? 'animate-pulse' : ''} />
          </button>
          <button
            type="button"
            onClick={() => setPickingNote(true)}
            disabled={isFlash || extractStatus === 'loading'}
            className="p-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
            title={t(isFlash ? 'input.attachBlockedFlash' : 'note.attach')}
            aria-label={t(isFlash ? 'input.attachBlockedFlashLabel' : 'note.attach')}
          >
            <NotebookPen size={16} />
          </button>
          {disabled && onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="p-2 rounded bg-red-700 hover:bg-red-600"
              title={t('input.stop')}
              aria-label={t('input.stop')}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={disabled || (!value.trim() && attachments.length === 0) || isOverLimit}
              className="p-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
              aria-label={t('input.send')}
            >
              <Send size={16} />
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" className="hidden" onChange={handleFile} />
      </div>
      </div>
      {/* Outside the collapsible block, so it stays visible and does not eat into that block's
          max-height budget. A session restored from a cookie or the PWA never passes the login
          screen, so this is the only AI notice such a user sees. */}
      <p className="pb-1 text-center text-[11px] text-gray-600">{t(AI_SYSTEM_NOTICE_SHORT)}</p>
      {pickingNote && <NotePicker onPick={attachNote} onClose={() => setPickingNote(false)} />}
    </form>
  )
}

/** Picks a note to inject in full into the next message.
 *
 *  Notes only: a file's text is stored as overlapping chunks, so attaching one would repeat passages
 *  — the paperclip already covers sending a document whole. */
function NotePicker({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const t = useT()
  const [notes, setNotes] = useState<Resource[] | null>(null)

  useEffect(() => {
    fetchFiles()
      .then(rs => setNotes(rs.filter(r => r.kind === 'note')))
      .catch(() => setNotes([]))
  }, [])

  return (
    <Modal title={t('note.attach')} onClose={onClose}>
      {notes === null && <p className="text-sm text-gray-500">{t('common.loading')}</p>}
      {notes?.length === 0 && <p className="text-sm text-gray-500">{t('note.attachEmpty')}</p>}
      <div className="flex flex-col gap-1.5">
        {notes?.map(note => (
          <button
            key={note.id}
            type="button"
            onClick={() => onPick(note.id)}
            className="text-left px-3 py-2 rounded bg-gray-800 hover:bg-gray-700"
          >
            <div className="text-sm text-gray-100 truncate">{note.filename}</div>
            {note.summary && <div className="text-xs text-gray-500 line-clamp-1">{note.summary}</div>}
          </button>
        ))}
      </div>
    </Modal>
  )
}
