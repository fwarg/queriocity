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
  const [view, setView] = useState<'chat' | 'library'>('chat')
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
          setSessions(prev => {
            const sid = chunk.sessionId as string
            if (prev.some(s => s.id === sid)) return prev
            return [{ id: sid, title: text.slice(0, 60) }, ...prev]
          })
        }
      }
    } finally {
      setMessages(prev => [...prev, { role: 'assistant', content: accumulated, sources }])
      setStreaming('')
      setStatus('')
      setBusy(false)
    }
  }

  function loadSession(id: string, title: string) {
    setSessionId(id)
    setMessages([])
    setStreaming('')
    setView('chat')
    fetchSession(id).then(setMessages).catch(() => {})
    // bring to top if not already
    setSessions(prev => [{ id, title }, ...prev.filter(s => s.id !== id)])
  }

  function newChat() {
    setMessages([])
    setSessionId(undefined)
    setStreaming('')
    setStatus('')
    setView('chat')
  }

  function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    deleteSession(id).then(() => {
      setSessions(prev => prev.filter(x => x.id !== id))
      if (sessionId === id) newChat()
    }).catch(() => {})
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col p-3 gap-1 overflow-y-auto">
        <button
          onClick={newChat}
          className="w-full text-left px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium"
        >
          + New chat
        </button>
        <button
          onClick={() => setView(v => v === 'library' ? 'chat' : 'library')}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'library' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          Library ({sessions.length})
        </button>
        <div className="border-t border-gray-800 my-1" />
        {sessions.map(s => (
          <div key={s.id} className={`flex items-center rounded hover:bg-gray-800 ${sessionId === s.id && view === 'chat' ? 'bg-gray-800' : ''}`}>
            <button
              onClick={() => loadSession(s.id, s.title)}
              className="flex-1 text-left px-3 py-2 text-sm truncate"
            >
              {s.title}
            </button>
            <button
              onClick={(e) => handleDelete(s.id, e)}
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
        {view === 'library' ? (
          <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-3">
            <h2 className="text-lg font-semibold text-gray-200 mb-2">Library</h2>
            {sessions.length === 0 ? (
              <p className="text-gray-500 text-sm">No saved chats yet.</p>
            ) : sessions.map(s => (
              <div key={s.id} className="flex items-center gap-2 group">
                <button
                  onClick={() => loadSession(s.id, s.title)}
                  className="flex-1 text-left px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-100"
                >
                  {s.title}
                </button>
                <button
                  onClick={(e) => handleDelete(s.id, e)}
                  className="px-2 py-2 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}
