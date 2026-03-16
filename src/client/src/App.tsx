import { useState, useEffect, useRef } from 'react'
import { MessageList } from './components/MessageList.tsx'
import { ChatInput } from './components/ChatInput.tsx'
import { LoginPage } from './components/LoginPage.tsx'
import { RegisterPage } from './components/RegisterPage.tsx'
import { SettingsPanel } from './components/SettingsPanel.tsx'
import { AdminPanel } from './components/AdminPanel.tsx'
import { streamChat, fetchHistory, fetchSession, deleteSession, getMe, hasUsers, logout } from './lib/api.ts'
import type { AuthUser, Message } from './lib/api.ts'

type AuthView = 'loading' | 'login' | 'register'

export default function App() {
  const [authView, setAuthView] = useState<AuthView>('loading')
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [inviteToken, setInviteToken] = useState<string | undefined>()

  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [focusMode, setFocusMode] = useState<'fast' | 'balanced' | 'thorough'>('balanced')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([])
  const [view, setView] = useState<'chat' | 'library'>('chat')
  const [showSettings, setShowSettings] = useState(false)
  const [showAdmin, setShowAdmin] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)

  // Bootstrap: check auth, read invite token from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    if (token) {
      setInviteToken(token)
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname)
    }

    getMe().then(user => {
      if (user) {
        setCurrentUser(user)
        setAuthView('loading') // stay in app
        fetchHistory().then(setSessions).catch(() => {})
      } else if (token) {
        setAuthView('register')
      } else {
        hasUsers().then(exists => setAuthView(exists ? 'login' : 'register'))
      }
    })
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  function handleAuthSuccess(user: AuthUser) {
    setCurrentUser(user)
    setAuthView('loading')
    fetchHistory().then(setSessions).catch(() => {})
  }

  async function handleLogout() {
    await logout()
    setCurrentUser(null)
    setSessions([])
    setMessages([])
    setAuthView('login')
  }

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

  // Auth screens
  if (authView === 'loading' && !currentUser) {
    return <div className="flex h-screen items-center justify-center text-gray-500 text-sm">Loading…</div>
  }
  if (authView === 'login') {
    return (
      <LoginPage
        onLogin={handleAuthSuccess}
        showRegisterLink={!!inviteToken}
        onRegister={() => setAuthView('register')}
      />
    )
  }
  if (authView === 'register') {
    return (
      <RegisterPage
        onRegister={handleAuthSuccess}
        inviteToken={inviteToken}
        showLoginLink={true}
        onLogin={() => setAuthView('login')}
      />
    )
  }

  return (
    <div className="flex h-screen">
      {showSettings && currentUser && (
        <SettingsPanel
          customPrompt={currentUser.settings?.customPrompt ?? ''}
          onClose={() => setShowSettings(false)}
          onSave={cp => setCurrentUser(u => u ? { ...u, settings: { ...u.settings, customPrompt: cp } } : u)}
        />
      )}
      {showAdmin && currentUser && (
        <AdminPanel currentUserId={currentUser.id} onClose={() => setShowAdmin(false)} />
      )}

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
            <button onClick={() => loadSession(s.id, s.title)} className="flex-1 text-left px-3 py-2 text-sm truncate">
              {s.title}
            </button>
            <button onClick={(e) => handleDelete(s.id, e)} className="px-2 py-2 text-gray-600 hover:text-red-400 shrink-0" title="Delete">
              ×
            </button>
          </div>
        ))}

        {/* Bottom user area */}
        <div className="mt-auto border-t border-gray-800 pt-2 flex flex-col gap-1">
          <button
            onClick={() => setShowSettings(true)}
            className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800"
          >
            ⚙ Settings
          </button>
          {currentUser?.role === 'admin' && (
            <button
              onClick={() => setShowAdmin(true)}
              className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800"
            >
              ◈ Admin
            </button>
          )}
          <button
            onClick={handleLogout}
            className="w-full text-left px-3 py-2 rounded text-xs text-gray-500 hover:bg-gray-800 hover:text-red-400"
          >
            Sign out — {currentUser?.name ?? currentUser?.email}
          </button>
        </div>
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
