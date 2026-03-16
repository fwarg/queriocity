import { useState, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { Send, Paperclip } from 'lucide-react'
import { uploadFile } from '../lib/api.ts'

interface Props {
  onSubmit: (text: string) => void
  disabled?: boolean
  focusMode: 'fast' | 'balanced' | 'thorough'
  onFocusModeChange: (m: 'fast' | 'balanced' | 'thorough') => void
}

const MODE_DESCRIPTIONS: Record<'fast' | 'balanced' | 'thorough', string> = {
  fast: 'Fast single-query search, streamed directly — best for simple factual questions.',
  balanced: 'LLM-reformulated query with a couple of search rounds and inline citations.',
  thorough: 'Multi-angle research with a dedicated writing pass — slower but more comprehensive.',
}

export function ChatInput({ onSubmit, disabled, focusMode, onFocusModeChange }: Props) {
  const [value, setValue] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const text = value.trim()
    if (!text || disabled) return
    onSubmit(text)
    setValue('')
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
    setUploading(true)
    try {
      await uploadFile(file)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 p-4 border-t border-gray-800">
      <div className="flex items-center gap-2 text-xs">
        {(['fast', 'balanced', 'thorough'] as const).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => onFocusModeChange(m)}
            className={`px-2 py-1 rounded capitalize ${focusMode === m ? 'bg-blue-600' : 'bg-gray-800 hover:bg-gray-700'}`}
          >
            {m}
          </button>
        ))}
        <span className="text-gray-500 ml-1">{MODE_DESCRIPTIONS[focusMode]}</span>
      </div>
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
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="p-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
            title="Upload file"
          >
            <Paperclip size={16} />
          </button>
          <button
            type="submit"
            disabled={disabled || !value.trim()}
            className="p-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            <Send size={16} />
          </button>
        </div>
        <input ref={fileRef} type="file" className="hidden" onChange={handleFile} />
      </div>
    </form>
  )
}
