import { useState, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { Send, Paperclip, X, Square, LayoutGrid } from 'lucide-react'
import { extractFileForContext } from '../lib/api.ts'
import { TemplateSelector } from './TemplateSelector.tsx'

type FocusMode = 'flash' | 'balanced' | 'thorough' | 'image'

interface Props {
  onSubmit: (text: string) => void
  onCancel?: () => void
  disabled?: boolean
  focusMode: FocusMode
  onFocusModeChange: (m: FocusMode) => void
}

interface Attachment {
  filename: string
  content: string
}

const FLASH_MAX = 200

const MODE_DESCRIPTIONS: Record<FocusMode, string> = {
  flash: 'Direct answer from model knowledge — no web search, max 5 sentences.',
  balanced: 'LLM-reformulated query with web search and inline citations.',
  thorough: 'Multi-angle research with a dedicated writing pass — slower but more comprehensive.',
  image: 'Generate or edit images — researches unfamiliar topics automatically for better results.',
}

export function ChatInput({ onSubmit, onCancel, disabled, focusMode, onFocusModeChange }: Props) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [extractStatus, setExtractStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [extractError, setExtractError] = useState('')
  const [showTemplates, setShowTemplates] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const isFlash = focusMode === 'flash'
  const isOverLimit = isFlash && value.length > FLASH_MAX

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
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e as unknown as FormEvent)
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
      setExtractError(err instanceof Error ? err.message : 'Failed to read file')
      setTimeout(() => setExtractStatus('idle'), 4000)
    } finally {
      e.target.value = ''
    }
  }

  return (
    <form onSubmit={handleSubmit} className="relative flex flex-col gap-2 p-4 border-t border-gray-800">
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
      <div className="flex items-center gap-2 text-xs">
        {(['flash', 'balanced', 'thorough', 'image'] as const).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => onFocusModeChange(m)}
            className={`px-2 py-1 rounded capitalize ${focusMode === m ? 'bg-blue-600' : 'bg-gray-800 hover:bg-gray-700'}`}
          >
            {m}
          </button>
        ))}
        {isFlash && (
          <span className={`ml-auto ${isOverLimit ? 'text-red-400' : 'text-gray-500'}`}>
            {value.length}/{FLASH_MAX}
          </span>
        )}
      </div>
      <div className="h-7 flex items-center text-xs text-gray-500 overflow-hidden">
        {MODE_DESCRIPTIONS[focusMode]}
      </div>
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
        <div className="text-xs text-gray-400 animate-pulse">Reading file…</div>
      )}
      {extractStatus === 'error' && (
        <div className="text-xs text-red-400">{extractError}</div>
      )}
      <div className="flex gap-2">
        <textarea
          className="flex-1 resize-none rounded bg-gray-900 border border-gray-700 p-2 text-sm focus:outline-none focus:border-blue-500"
          rows={3}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"
          disabled={disabled}
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowTemplates(v => !v)}
            className={`p-2 rounded ${showTemplates ? 'bg-blue-700 hover:bg-blue-600' : 'bg-gray-800 hover:bg-gray-700'}`}
            title="Use a prompt template"
            aria-label="Prompt templates"
          >
            <LayoutGrid size={16} />
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={isFlash || extractStatus === 'loading'}
            className="p-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
            title={isFlash ? 'Not available in flash mode' : 'Attach file to this message (not stored)'}
            aria-label={isFlash ? 'Attach file (not available in flash mode)' : 'Attach file to this message'}
          >
            <Paperclip size={16} className={extractStatus === 'loading' ? 'animate-pulse' : ''} />
          </button>
          {disabled && onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="p-2 rounded bg-red-700 hover:bg-red-600"
              title="Stop generation"
              aria-label="Stop generation"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={disabled || (!value.trim() && attachments.length === 0) || isOverLimit}
              className="p-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
              aria-label="Send message"
            >
              <Send size={16} />
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" className="hidden" onChange={handleFile} />
      </div>
    </form>
  )
}
