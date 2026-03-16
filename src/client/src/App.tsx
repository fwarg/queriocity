import { useState, useEffect, useRef } from 'react'
import { MessageList } from './components/MessageList.tsx'
import { ChatInput } from './components/ChatInput.tsx'
import { streamChat, fetchHistory, fetchSession, deleteSession, ensureSession } from './lib/api.ts'
import type { Message } from './lib/api.ts'

export default function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [focusMode, setFocusMode] = useState<'fast' | 'balanced' | 'thorough'>('balanced')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ensureSession().then(() => fetchHistory().then(setSessions).catch(() => {}))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  async function handleSubmit(text: string) {
    const userMsg: Message = { role: 'user', content: text }
    const next = [...messages, userMsg]
    setMessages(next)
    setBusy(true)
    setStreaming('')

    let accumulated = ''
    const sources: Array<{ title: string; url: string }> = []

    try {
      for await (const chunk of streamChat(next, focusMode, sessionId)) {
        if (chunk.type === 'text') {
          accumulated += chunk.delta as string
          setStreaming(accumulated)
          setStatus('')
        } else if (chunk.type === 'status') {
          setStatus(chunk.text as string)
        } else if (chunk.type === 'sources') {
          sources.push(...(chunk.sources as Array<{ title: string; url: string }>))
        } else if (chunk.type === 'done') {
          setSessionId(chunk.sessionId as string)
        }
      }
    } finally {
      setMessages(prev => [...prev, { role: 'assistant', content: accumulated, sources }])
      setStreaming('')
      setStatus('')
      setBusy(false)
    }
  }

  function newChat() {
    setMessages([])
    setSessionId(undefined)
    setStreaming('')
    setStatus('')
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col p-3 gap-2 overflow-y-auto">
        <button
          onClick={newChat}
          className="w-full text-left px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium"
        >
          + New chat
        </button>
        {sessions.map(s => (
          <div key={s.id} className={`flex items-center rounded hover:bg-gray-800 ${sessionId === s.id ? 'bg-gray-800' : ''}`}>
            <button
              onClick={() => {
                setSessionId(s.id)
                setMessages([])
                setStreaming('')
                fetchSession(s.id).then(setMessages).catch(() => {})
              }}
              className="flex-1 text-left px-3 py-2 text-sm truncate"
            >
              {s.title}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                deleteSession(s.id).then(() => {
                  setSessions(prev => prev.filter(x => x.id !== s.id))
                  if (sessionId === s.id) newChat()
                }).catch(() => {})
              }}
              className="px-2 py-2 text-gray-600 hover:text-red-400 shrink-0"
              title="Delete"
            >
              ×
            </button>
          </div>
        ))}
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 min-h-0">
        {messages.length === 0 && !streaming ? (
          <div className="flex flex-col items-center justify-center flex-1 gap-2 text-gray-500">
            <span className="text-2xl font-semibold text-gray-300">Queriocity</span>
            <span className="text-sm">LLM-driven web search</span>
          </div>
        ) : (
          <MessageList messages={messages} streaming={streaming} />
        )}
        {status && (
          <div className="px-4 py-1 text-xs text-gray-500 italic animate-pulse">{status}</div>
        )}
        <div ref={bottomRef} />
        <ChatInput
          onSubmit={handleSubmit}
          disabled={busy}
          focusMode={focusMode}
          onFocusModeChange={setFocusMode}
        />
      </div>
    </div>
  )
}
