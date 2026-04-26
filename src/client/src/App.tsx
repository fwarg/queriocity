import { useState, useEffect, useRef } from 'react'
import { MessageList } from './components/MessageList.tsx'
import { ChatInput } from './components/ChatInput.tsx'
import { LoginPage } from './components/LoginPage.tsx'
import { RegisterPage } from './components/RegisterPage.tsx'
import { SettingsPanel } from './components/SettingsPanel.tsx'
import { AdminPanel } from './components/AdminPanel.tsx'
import { MonitorsView } from './components/MonitorsView.tsx'
import {
  fetchHistory, fetchSession, deleteSession, updateSessionTitle,
  fetchFiles, deleteFile, uploadFile, getMe, hasUsers, logout,
  fetchSpaces, createSpace, updateSpace, deleteSpace, assignChatToSpace, recreateChatMemories,
  fetchSpaceMemories, createSpaceMemory, updateSpaceMemory, deleteSpaceMemory, compactSpaceMemories, recreateAllSpaceMemories, clearSpaceMemories,
  fetchChatIndexStatus, rebuildChatIndex, searchHistory,
  fetchSpaceFiles, tagFileToSpace, untagFileFromSpace,
} from './lib/api.ts'
import type { AuthUser, Message, Space, SpaceMemory, SpaceFile } from './lib/api.ts'
import { useChat } from './hooks/useChat.ts'

type AuthView = 'loading' | 'login' | 'register'
type MainView = 'chat' | 'chats' | 'files' | 'spaces' | 'monitors'
type Session = { id: string; title: string; spaceId: string | null }

type UploadedFile = { id: string; filename: string; mimeType: string; size: number; createdAt: number }

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const MEMORY_HEADER_TOKENS = 30

function countOverflowMemories(memories: SpaceMemory[], budget: number): number {
  let acc = MEMORY_HEADER_TOKENS
  let injected = 0
  for (const m of memories) {
    acc += Math.ceil(m.content.length / 4)
    if (acc > budget) break
    injected++
  }
  return Math.max(0, memories.length - injected)
}

export default function App() {
  const [authView, setAuthView] = useState<AuthView>('loading')
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [inviteToken, setInviteToken] = useState<string | undefined>()

  const [focusMode, setFocusMode] = useState<'flash' | 'balanced' | 'thorough' | 'image'>('balanced')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [monitorCount, setMonitorCount] = useState(0)
  const [currentSpaceId, setCurrentSpaceId] = useState<string | null>(null)
  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null)
  const [spaceDraft, setSpaceDraft] = useState('')
  const [newSpaceOpen, setNewSpaceOpen] = useState(false)
  const [newSpaceDraft, setNewSpaceDraft] = useState('')
  const [spacePickerOpen, setSpacePickerOpen] = useState<string | null>(null)
  const [spaceMemories, setSpaceMemories] = useState<SpaceMemory[]>([])
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [newMemoryOpen, setNewMemoryOpen] = useState(false)
  const [newMemoryDraft, setNewMemoryDraft] = useState('')
  const [memorySectionOpen, setMemorySectionOpen] = useState(false)
  const [taggedFiles, setTaggedFiles] = useState<SpaceFile[]>([])
  const [chatIndexStatus, setChatIndexStatus] = useState<{ indexed: number; total: number } | null>(null)
  const [rebuildingIndex, setRebuildingIndex] = useState(false)
  const [rebuildIndexProgress, setRebuildIndexProgress] = useState<string | null>(null)
  const [filesSectionOpen, setFilesSectionOpen] = useState(false)
  const [allUserFiles, setAllUserFiles] = useState<Array<{ id: string; filename: string; size: number }>>([])
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [compactResult, setCompactResult] = useState<string | null>(null)
  const [recreating, setRecreating] = useState(false)
  const [recreateProgress, setRecreateProgress] = useState<string | null>(null)
  const [view, setView] = useState<MainView>('chat')
  const [showSettings, setShowSettings] = useState(false)
  const [showAdmin, setShowAdmin] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [chatSort, setChatSort] = useState<'updated' | 'created'>('updated')
  const [chatSearch, setChatSearch] = useState('')
  const [chatSearchResults, setChatSearchResults] = useState<Session[] | null>(null)
  const [chatTotal, setChatTotal] = useState(0)
  const [chatHasMore, setChatHasMore] = useState(false)
  const [chatLoadingMore, setChatLoadingMore] = useState(false)
  const chatOffsetRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const sidebarSentinelRef = useRef<HTMLDivElement>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  const activeSpaceId = sessionId
    ? sessions.find(s => s.id === sessionId)?.spaceId ?? null
    : currentSpaceId

  const { messages, setMessages, streaming, streamingThinking, status, setStatus, answerTime, busy, submit, cancel, reset } = useChat({
    sessionId,
    focusMode,
    spaceId: activeSpaceId ?? undefined,
    onSessionCreated: (id, title) => {
      setSessionId(id)
      setSessions(prev => prev.some(s => s.id === id) ? prev : [{ id, title, spaceId: activeSpaceId }, ...prev])
      if (activeSpaceId) {
        setSpaces(sps => sps.map(sp => sp.id === activeSpaceId ? { ...sp, chatCount: sp.chatCount + 1 } : sp))
        fetchSpaceMemories(activeSpaceId).then(({ memories }) => setSpaceMemories(memories)).catch(() => {})
      }
    },
  })

  const bottomRef = useRef<HTMLDivElement>(null)

  const fontSize = currentUser?.settings?.fontSize ?? 16
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`
  }, [fontSize])

  const PAGE_SIZE = 50

  function loadChats(sort: 'updated' | 'created', offset: number, replace: boolean) {
    setChatLoadingMore(true)
    fetchHistory(sort, offset)
      .then(({ items, total }) => {
        setSessions(prev => replace ? items : [...prev, ...items])
        setChatTotal(total)
        chatOffsetRef.current = offset + items.length
        setChatHasMore(items.length === PAGE_SIZE)
      })
      .catch(() => {})
      .finally(() => setChatLoadingMore(false))
  }

  useEffect(() => {
    if (!currentUser) return
    chatOffsetRef.current = 0
    setSessions([])
    setChatHasMore(false)
    loadChats(chatSort, 0, true)
  }, [chatSort, currentUser])

  useEffect(() => {
    if (!chatSearch.trim()) { setChatSearchResults(null); return }
    const t = setTimeout(() => {
      searchHistory(chatSearch.trim()).then(items => setChatSearchResults(items)).catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [chatSearch])

  useEffect(() => {
    const callback = ([entry]: IntersectionObserverEntry[]) => {
      if (entry.isIntersecting && !chatLoadingMore && chatHasMore) {
        loadChats(chatSort, chatOffsetRef.current, false)
      }
    }
    const obs = new IntersectionObserver(callback)
    if (sentinelRef.current) obs.observe(sentinelRef.current)
    if (sidebarSentinelRef.current) obs.observe(sidebarSentinelRef.current)
    return () => obs.disconnect()
  }, [chatHasMore, chatLoadingMore, chatSort])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    if (token) {
      setInviteToken(token)
      window.history.replaceState({}, '', window.location.pathname)
    }

    getMe().then(user => {
      if (user) {
        setCurrentUser(user)
        setAuthView('loading')
        fetchFiles().then(setFiles).catch(() => {})
        fetchSpaces().then(setSpaces).catch(() => {})
      } else if (token) {
        setAuthView('register')
      } else {
        hasUsers().then(exists => setAuthView(exists ? 'login' : 'register'))
      }
    })
  }, [])

  useEffect(() => {
    if (currentSpaceId) {
      fetchSpaceMemories(currentSpaceId).then(({ memories }) => { setSpaceMemories(memories) }).catch(() => {})
      fetchSpaceFiles(currentSpaceId).then(setTaggedFiles).catch(() => {})
      fetchChatIndexStatus(currentSpaceId).then(setChatIndexStatus).catch(() => {})
    } else {
      setSpaceMemories([])
      setTaggedFiles([])
      setChatIndexStatus(null)
    }
    setMemorySectionOpen(false)
    setFilesSectionOpen(false)
    setFilePickerOpen(false)
    setNewMemoryOpen(false)
    setCompactResult(null)
    setRecreateProgress(null)
  }, [currentSpaceId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  function handleAuthSuccess(user: AuthUser) {
    setCurrentUser(user)
    setAuthView('loading')
    fetchFiles().then(setFiles).catch(() => {})
    fetchSpaces().then(setSpaces).catch(() => {})
  }

  async function handleLogout() {
    await logout()
    setCurrentUser(null)
    setSessions([])
    setFiles([])
    setSpaces([])
    setMessages([])
    setCurrentSpaceId(null)
    setAuthView('login')
  }


  function loadSession(id: string, title: string, addToHistory = true) {
    setSessionId(id)
    setEditingTitle(false)
    reset()
    setView('chat')
    fetchSession(id).then(setMessages).catch(() => {})
    if (addToHistory) {
      setSessions(prev => {
        const existing = prev.find(s => s.id === id)
        return [{ id, title, spaceId: existing?.spaceId ?? null }, ...prev.filter(s => s.id !== id)]
      })
    }
  }

  function newChat(inSpaceId?: string) {
    setSessionId(undefined)
    setEditingTitle(false)
    reset()
    setCurrentSpaceId(inSpaceId ?? null)
    setView('chat')
  }

  function buildSessionMarkdown(msgs: Message[], title: string, scope: 'full' | 'last'): string {
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const header = `# ${title}\n_Exported: ${date}_\n\n`
    const subset = scope === 'last' ? msgs.filter(m => m.role === 'assistant').slice(-1) : msgs
    const body = subset.map((m, msgIdx) => {
      const label = m.role === 'user' ? '**User**' : '**Assistant**'
      let content = m.content
      if (m.role === 'assistant' && m.sources?.length) {
        content = content.replace(/\[(\d+)\]/g, (_, n) => `[\\[${n}\\]](#ref-${msgIdx}-${n})`)
      }
      let block = `${label}\n\n${content}`
      if (m.sources?.length) {
        block += '\n\n**Sources**\n' + m.sources.map((s, i) => `${i + 1}. <a id="ref-${msgIdx}-${i + 1}"></a>[${s.title}](${s.url})`).join('\n')
      }
      return block
    }).join('\n\n---\n\n')
    return header + body
  }

  function handleTitleSave() {
    const trimmed = titleDraft.trim()
    if (!trimmed || !sessionId) { setEditingTitle(false); return }
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title: trimmed } : s))
    setEditingTitle(false)
    updateSessionTitle(sessionId, trimmed).catch(() => {})
  }

  function handleExport(scope: 'full' | 'last') {
    const title = sessions.find(s => s.id === sessionId)?.title ?? 'chat'
    const content = buildSessionMarkdown(messages, title, scope)
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
    const filename = scope === 'last' ? `${slug}-last-answer.md` : `${slug}.md`
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    setExportOpen(false)
  }

  function handleDeleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    deleteSession(id).then(() => {
      setSessions(prev => {
        const session = prev.find(s => s.id === id)
        if (session?.spaceId) {
          setSpaces(sps => sps.map(sp => sp.id === session.spaceId ? { ...sp, chatCount: Math.max(0, sp.chatCount - 1) } : sp))
        }
        return prev.filter(x => x.id !== id)
      })
      if (sessionId === id) newChat()
    }).catch(() => setStatus('Failed to delete chat.'))
  }

  function handleDeleteFile(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    deleteFile(id).then(() => setFiles(prev => prev.filter(f => f.id !== id))).catch(() => {})
  }

  function handleCreateSpace() {
    const name = newSpaceDraft.trim()
    if (!name) { setNewSpaceOpen(false); return }
    createSpace(name).then(s => {
      setSpaces(prev => [...prev, s])
      setNewSpaceDraft('')
      setNewSpaceOpen(false)
    }).catch(() => {})
  }

  function handleDeleteSpace(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    const sp = spaces.find(s => s.id === id)
    const label = sp ? `"${sp.name}"` : 'this space'
    if (!confirm(`Delete ${label}? This will permanently delete all its memories. Chats will be unassigned but not deleted.`)) return
    deleteSpace(id).then(() => {
      setSpaces(prev => prev.filter(s => s.id !== id))
      setSessions(prev => prev.map(s => s.spaceId === id ? { ...s, spaceId: null } : s))
      if (currentSpaceId === id) setCurrentSpaceId(null)
    }).catch(() => {})
  }

  function handleSpaceRenameSave(id: string) {
    const name = spaceDraft.trim()
    setEditingSpaceId(null)
    if (!name) return
    setSpaces(prev => prev.map(s => s.id === id ? { ...s, name } : s))
    updateSpace(id, name).catch(() => {})
  }

  function handleAssignToSpace(chatId: string, spaceId: string | null) {
    const prevSpaceId = sessions.find(s => s.id === chatId)?.spaceId ?? null
    setSessions(prev => prev.map(s => s.id === chatId ? { ...s, spaceId } : s))
    setSpaces(prev => prev.map(sp => {
      if (sp.id === prevSpaceId) return { ...sp, chatCount: Math.max(0, sp.chatCount - 1) }
      if (sp.id === spaceId) return { ...sp, chatCount: sp.chatCount + 1 }
      return sp
    }))
    setSpacePickerOpen(null)
    assignChatToSpace(chatId, spaceId).catch(() => {})
  }

  function handleCreateMemory() {
    const content = newMemoryDraft.trim()
    if (!content || !currentSpaceId) { setNewMemoryOpen(false); return }
    createSpaceMemory(currentSpaceId, content).then(m => {
      setSpaceMemories(prev => [m, ...prev])
      setNewMemoryDraft('')
      setNewMemoryOpen(false)
    }).catch(() => {})
  }

  function handleDeleteMemory(id: string) {
    if (!currentSpaceId) return
    deleteSpaceMemory(currentSpaceId, id).then(() => {
      setSpaceMemories(prev => prev.filter(m => m.id !== id))
    }).catch(() => {})
  }

  function handleMemorySave(id: string) {
    const content = memoryDraft.trim()
    setEditingMemoryId(null)
    if (!content || !currentSpaceId) return
    setSpaceMemories(prev => prev.map(m => m.id === id ? { ...m, content } : m))
    updateSpaceMemory(currentSpaceId, id, content).catch(() => {})
  }

  const kbFileRef = useRef<HTMLInputElement>(null)
  const [kbUploadStatus, setKbUploadStatus] = useState<'idle' | 'uploading' | 'ok' | 'error'>('idle')
  const [kbUploadMsg, setKbUploadMsg] = useState('')

  async function handleKbUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setKbUploadStatus('uploading')
    setKbUploadMsg(`Uploading ${file.name}…`)
    try {
      await uploadFile(file)
      setKbUploadStatus('ok')
      setKbUploadMsg(`"${file.name}" added to knowledge base`)
      fetchFiles().then(setFiles).catch(() => {})
      setTimeout(() => setKbUploadStatus('idle'), 3000)
    } catch (err: unknown) {
      setKbUploadStatus('error')
      setKbUploadMsg(err instanceof Error ? err.message : 'Upload failed')
      setTimeout(() => setKbUploadStatus('idle'), 4000)
    } finally {
      e.target.value = ''
    }
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
          showThinking={currentUser.settings?.showThinking ?? { balanced: false, thorough: false }}
          useThinking={currentUser.settings?.useThinking ?? false}
          useSpaceRag={currentUser.settings?.useSpaceRag !== false}
          useChatRag={currentUser.settings?.useChatRag !== false}
          fontSize={currentUser.settings?.fontSize ?? 16}
          timezone={currentUser.settings?.timezone ?? ''}
          onClose={() => setShowSettings(false)}
          onSave={(cp, st, ut, sr, cr, fs, tz) => setCurrentUser(u => u ? { ...u, settings: { ...u.settings, customPrompt: cp, showThinking: st, useThinking: ut, useSpaceRag: sr, useChatRag: cr, fontSize: fs, timezone: tz } } : u)}
        />
      )}
      {showAdmin && currentUser && (
        <AdminPanel
          currentUserId={currentUser.id}
          onClose={() => setShowAdmin(false)}
          onBudgetChange={budget => setCurrentUser(prev => prev ? { ...prev, memoryTokenBudget: budget } : prev)}
        />
      )}

      {/* Sidebar — overlay on mobile, static on md+ */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`
        fixed inset-y-0 left-0 z-30 w-64 bg-gray-900 border-r border-gray-800 flex flex-col p-3 gap-1
        transform transition-transform duration-200
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        md:relative md:translate-x-0 md:w-56 md:z-auto md:transition-none
      `}>
        <div className="px-3 py-2">
          <div className="text-base font-bold text-white tracking-wide">Queriocity</div>
          <div className="text-xs text-gray-500">v{__APP_VERSION__}</div>
        </div>
        <button
          onClick={() => { newChat(); setSidebarOpen(false) }}
          className="w-full text-left px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium"
        >
          + New chat
        </button>
        <button
          onClick={() => { setView(v => v === 'chats' ? 'chat' : 'chats'); setSidebarOpen(false) }}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'chats' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          Chats ({chatTotal || sessions.length})
        </button>
        <button
          onClick={() => { setView(v => v === 'files' ? 'chat' : 'files'); setSidebarOpen(false) }}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'files' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          Files ({files.length})
        </button>
        <button
          onClick={() => { setView(v => v === 'spaces' ? 'chat' : 'spaces'); setCurrentSpaceId(null); setSidebarOpen(false) }}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'spaces' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          Spaces ({spaces.length})
        </button>
        <button
          onClick={() => { setView(v => v === 'monitors' ? 'chat' : 'monitors'); setSidebarOpen(false) }}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'monitors' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          Monitors ({monitorCount})
        </button>
        <div className="border-t border-gray-800 my-1" />
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
          {sessions.length > 5 && (
            <input
              type="search"
              placeholder="Search chats…"
              value={sessionSearch}
              onChange={e => setSessionSearch(e.target.value)}
              className="mx-1 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
            />
          )}
          {sessions.filter(s => !sessionSearch || s.title.toLowerCase().includes(sessionSearch.toLowerCase())).map(s => (
            <div key={s.id} className={`flex items-center rounded hover:bg-gray-800 ${sessionId === s.id && view === 'chat' ? 'bg-gray-800' : ''}`}>
              <button onClick={() => { loadSession(s.id, s.title); setSidebarOpen(false) }} className="flex-1 text-left px-3 py-2 text-sm truncate">
                {s.title}
              </button>
              <button onClick={(e) => handleDeleteSession(s.id, e)} className="px-2 py-2 text-gray-600 hover:text-red-400 shrink-0" aria-label={`Delete "${s.title}"`}>
                ×
              </button>
            </div>
          ))}
          <div ref={sidebarSentinelRef} className="py-1 text-center text-xs text-gray-600">
            {chatLoadingMore ? 'Loading…' : ''}
          </div>
        </div>

        {/* Bottom user area */}
        <div className="border-t border-gray-800 pt-2 flex flex-col gap-1">
          <button onClick={() => { setShowSettings(true); setSidebarOpen(false) }} className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800">
            ⚙ Settings
          </button>
          {currentUser?.role === 'admin' && (
            <button onClick={() => { setShowAdmin(true); setSidebarOpen(false) }} className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800">
              ◈ Admin
            </button>
          )}
          <button onClick={handleLogout} className="w-full text-left px-3 py-2 rounded text-xs text-gray-500 hover:bg-gray-800 hover:text-red-400">
            Sign out — {currentUser?.name ?? currentUser?.email}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        {/* Mobile header bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-400 hover:text-white text-xl leading-none"
            aria-label="Open menu"
          >
            ☰
          </button>
          <span className="font-semibold text-white text-sm">Queriocity</span>
        </div>
        {view === 'chats' ? (
          <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-3" onClick={() => setSpacePickerOpen(null)}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-gray-200">Chats</h2>
              {!chatSearchResults && (
                <div className="flex items-center gap-1 text-xs">
                  <button onClick={() => setChatSort('updated')} className={chatSort === 'updated' ? 'text-indigo-400' : 'text-gray-500 hover:text-gray-300'}>Active</button>
                  <span className="text-gray-700">·</span>
                  <button onClick={() => setChatSort('created')} className={chatSort === 'created' ? 'text-indigo-400' : 'text-gray-500 hover:text-gray-300'}>Created</button>
                </div>
              )}
            </div>
            <input
              type="search"
              placeholder="Search titles and content…"
              value={chatSearch}
              onChange={e => setChatSearch(e.target.value)}
              className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none focus:border-indigo-500 mb-1"
            />
            {chatSearchResults !== null && (
              <p className="text-xs text-gray-500 mb-1">
                {chatSearchResults.length === 0 ? 'No results' : `${chatSearchResults.length} result${chatSearchResults.length !== 1 ? 's' : ''}`}
              </p>
            )}
            {(chatSearchResults ?? sessions).length === 0 && !chatSearch ? (
              <p className="text-gray-500 text-sm">No saved chats yet.</p>
            ) : (chatSearchResults ?? sessions).map(s => {
              const spaceName = s.spaceId ? spaces.find(sp => sp.id === s.spaceId)?.name : null
              return (
                <div key={s.id} className="flex items-center gap-2 group relative">
                  <button
                    onClick={() => loadSession(s.id, s.title)}
                    className="flex-1 text-left px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-100"
                  >
                    {s.title}
                  </button>
                  {spaces.length > 0 && (
                    <div className="relative shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); setSpacePickerOpen(prev => prev === s.id ? null : s.id) }}
                        className={`px-2 py-1 rounded text-xs transition-opacity ${spaceName ? 'text-indigo-400 bg-indigo-900/40' : 'text-gray-600 hover:text-gray-400 md:opacity-0 md:group-hover:opacity-100'}`}
                        title="Move to space"
                      >
                        {spaceName ?? '⊡'}
                      </button>
                      {spacePickerOpen === s.id && (
                        <div className="absolute right-0 top-full mt-1 z-10 bg-gray-800 border border-gray-700 rounded shadow-lg min-w-36 py-1" onClick={e => e.stopPropagation()}>
                          {spaces.map(sp => (
                            <button
                              key={sp.id}
                              onClick={() => handleAssignToSpace(s.id, sp.id)}
                              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 ${s.spaceId === sp.id ? 'text-indigo-400' : 'text-gray-300'}`}
                            >
                              {sp.name}
                            </button>
                          ))}
                          {s.spaceId && (
                            <button
                              onClick={() => handleAssignToSpace(s.id, null)}
                              className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-700 hover:text-red-400 border-t border-gray-700 mt-1 pt-1"
                            >
                              Remove from space
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    onClick={(e) => handleDeleteSession(s.id, e)}
                    className="px-2 py-2 text-gray-600 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
                    aria-label={`Delete "${s.title}"`}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            {!chatSearchResults && (
              <div ref={sentinelRef} className="py-1 text-center text-xs text-gray-600">
                {chatLoadingMore ? 'Loading…' : ''}
              </div>
            )}
          </div>
        ) : view === 'spaces' ? (
          currentSpaceId ? (
            <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-3">
              <div className="flex items-center gap-3 mb-2">
                <button
                  onClick={() => setCurrentSpaceId(null)}
                  className="text-gray-500 hover:text-gray-300 text-sm"
                >
                  ← Spaces
                </button>
                {editingSpaceId === currentSpaceId ? (
                  <input
                    autoFocus
                    type="text"
                    value={spaceDraft}
                    onChange={e => setSpaceDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSpaceRenameSave(currentSpaceId); if (e.key === 'Escape') setEditingSpaceId(null) }}
                    onBlur={() => handleSpaceRenameSave(currentSpaceId)}
                    className="text-lg font-semibold bg-transparent border-b border-indigo-500 text-gray-100 focus:outline-none"
                  />
                ) : (
                  <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">
                    {spaces.find(s => s.id === currentSpaceId)?.name ?? ''}
                    <button
                      onClick={() => { setSpaceDraft(spaces.find(s => s.id === currentSpaceId)?.name ?? ''); setEditingSpaceId(currentSpaceId) }}
                      className="text-gray-600 hover:text-gray-400 text-sm"
                      aria-label="Rename space"
                    >
                      ✎
                    </button>
                  </h2>
                )}
                <button
                  onClick={() => newChat(currentSpaceId!)}
                  className="ml-auto px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium whitespace-nowrap"
                >
                  + New chat
                </button>
              </div>
              {/* Memory section */}
              <div className="border border-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setMemorySectionOpen(o => !o)}
                    className="flex items-center gap-1.5 text-sm font-medium text-gray-400 hover:text-gray-200"
                  >
                    <span>{memorySectionOpen ? '▾' : '▸'}</span>
                    Memory ({spaceMemories.length})
                  </button>
                  {memorySectionOpen && !newMemoryOpen && (
                    <div className="flex items-center gap-2">
                      {spaceMemories.length > 1 && (
                        <button
                          onClick={async () => {
                            setCompacting(true)
                            setCompactResult(null)
                            try {
                              const { before, after, compacted } = await compactSpaceMemories(currentSpaceId!)
                              if (compacted) fetchSpaceMemories(currentSpaceId!).then(({ memories }) => { setSpaceMemories(memories) }).catch(() => {})
                              setCompactResult(compacted ? `${before} → ${after}` : 'Already within target')
                              setTimeout(() => setCompactResult(null), 4000)
                            } finally {
                              setCompacting(false)
                            }
                          }}
                          disabled={compacting}
                          className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50"
                        >
                          {compacting ? 'Compacting…' : 'Compact'}
                        </button>
                      )}
                      {compactResult && <span className="text-xs text-gray-500">{compactResult}</span>}
                      <button
                        onClick={async () => {
                          if (!confirm('Clear all auto-extracted memories and re-extract from all chats? Manual memories will be kept.')) return
                          setRecreating(true)
                          setRecreateProgress(null)
                          setCompactResult(null)
                          try {
                            for await (const ev of recreateAllSpaceMemories(currentSpaceId!)) {
                              if (ev.processing !== undefined) setRecreateProgress(`${ev.processing}/${ev.total}`)
                              if (ev.done) {
                                fetchSpaceMemories(currentSpaceId!).then(({ memories }) => { setSpaceMemories(memories) }).catch(() => {})
                                if (ev.errors) {
                                  setCompactResult(`${ev.errors} chat${ev.errors > 1 ? 's' : ''} failed — reduce extraction context in settings`)
                                  setTimeout(() => setCompactResult(null), 6000)
                                }
                              }
                            }
                          } finally {
                            setRecreating(false)
                            setRecreateProgress(null)
                          }
                        }}
                        disabled={compacting || recreating}
                        className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50"
                      >
                        {recreating ? (recreateProgress ? `Processing (${recreateProgress})` : 'Starting…') : 'Recreate all'}
                      </button>
                      <button
                        onClick={async () => {
                          if (!confirm('Delete all memories in this space? This cannot be undone.')) return
                          await clearSpaceMemories(currentSpaceId!)
                          setSpaceMemories([])
                        }}
                        disabled={compacting || recreating}
                        className="text-xs text-gray-500 hover:text-red-400 disabled:opacity-50"
                      >
                        Clear all
                      </button>
                      <button onClick={() => setNewMemoryOpen(true)} className="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
                    </div>
                  )}
                </div>
                {memorySectionOpen && (() => {
                  const overflow = countOverflowMemories(spaceMemories, currentUser?.memoryTokenBudget ?? 1000)
                  return overflow > 0 ? (
                    <p className="text-xs text-amber-500/80 mt-1">
                      {overflow} {overflow === 1 ? 'memory exceeds' : 'memories exceed'} the token budget and won't be injected.
                    </p>
                  ) : null
                })()}
                {memorySectionOpen && newMemoryOpen && (
                  <div className="mb-2">
                    <input
                      autoFocus
                      type="text"
                      value={newMemoryDraft}
                      onChange={e => setNewMemoryDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleCreateMemory(); if (e.key === 'Escape') { setNewMemoryOpen(false); setNewMemoryDraft('') } }}
                      onBlur={handleCreateMemory}
                      placeholder="Add a fact…"
                      className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                )}
                {memorySectionOpen && spaceMemories.length === 0 && !newMemoryOpen ? (
                  <p className="text-xs text-gray-600 mt-2">No memories yet. The assistant will save noteworthy facts from conversations in this space.</p>
                ) : memorySectionOpen && spaceMemories.map(m => (
                  <div key={m.id} className="flex items-start gap-1.5 group py-1">
                    {editingMemoryId === m.id ? (
                      <input
                        autoFocus
                        type="text"
                        value={memoryDraft}
                        onChange={e => setMemoryDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleMemorySave(m.id); if (e.key === 'Escape') setEditingMemoryId(null) }}
                        onBlur={() => handleMemorySave(m.id)}
                        className="flex-1 px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                      />
                    ) : (
                      <span
                        onClick={() => { setMemoryDraft(m.content); setEditingMemoryId(m.id) }}
                        className="flex-1 text-xs text-gray-300 cursor-pointer hover:text-gray-100"
                      >
                        {m.content}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-600 shrink-0 mt-0.5">{m.source === 'tool' ? 'auto' : m.source === 'extraction' ? 'extracted' : m.source === 'compact' ? 'compact' : 'manual'}</span>
                    {editingMemoryId !== m.id && (
                      <button
                        onClick={() => { setMemoryDraft(m.content); setEditingMemoryId(m.id) }}
                        className="text-gray-700 hover:text-gray-400 text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label="Edit"
                      >
                        ✎
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteMemory(m.id)}
                      className="text-gray-700 hover:text-red-400 text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {/* Tagged files section */}
              <div className="border border-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setFilesSectionOpen(o => !o)}
                    className="flex items-center gap-1.5 text-sm font-medium text-gray-400 hover:text-gray-200"
                  >
                    <span>{filesSectionOpen ? '▾' : '▸'}</span>
                    Tagged files ({taggedFiles.length})
                  </button>
                  {filesSectionOpen && (
                    <button
                      onClick={async () => {
                        const all = await fetchFiles()
                        setAllUserFiles(all.filter(f => !taggedFiles.some(t => t.id === f.id)))
                        setFilePickerOpen(o => !o)
                      }}
                      className="text-xs text-gray-500 hover:text-gray-300"
                    >
                      + Tag file
                    </button>
                  )}
                </div>
                {filesSectionOpen && filePickerOpen && allUserFiles.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1 border border-gray-700 rounded p-2 bg-gray-900">
                    {allUserFiles.map(f => (
                      <button
                        key={f.id}
                        onClick={async () => {
                          await tagFileToSpace(currentSpaceId!, f.id)
                          fetchSpaceFiles(currentSpaceId!).then(setTaggedFiles).catch(() => {})
                          setFilePickerOpen(false)
                        }}
                        className="text-left text-xs text-gray-300 hover:text-white px-1 py-0.5 hover:bg-gray-800 rounded truncate"
                      >
                        {f.filename}
                      </button>
                    ))}
                  </div>
                )}
                {filesSectionOpen && filePickerOpen && allUserFiles.length === 0 && (
                  <p className="text-xs text-gray-600 mt-2">No untagged files available.</p>
                )}
                {filesSectionOpen && taggedFiles.length === 0 && !filePickerOpen && (
                  <p className="text-xs text-gray-600 mt-2">No files tagged. Tag library files to inject relevant excerpts into the space context.</p>
                )}
                {filesSectionOpen && taggedFiles.map(f => (
                  <div key={f.id} className="flex items-center justify-between group py-1">
                    <span className="text-xs text-gray-300 truncate min-w-0">{f.filename}</span>
                    <button
                      onClick={async () => {
                        await untagFileFromSpace(currentSpaceId!, f.id)
                        setTaggedFiles(prev => prev.filter(t => t.id !== f.id))
                      }}
                      className="text-gray-700 hover:text-red-400 text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ml-2"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {chatIndexStatus !== null && (
                <div className="border border-gray-800 rounded-lg p-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-500">
                    Chat index: {chatIndexStatus.indexed}/{chatIndexStatus.total} sessions
                    {chatIndexStatus.indexed < chatIndexStatus.total && (
                      <span className="text-amber-500/80"> ⚠</span>
                    )}
                  </span>
                  <button
                    onClick={async () => {
                      setRebuildingIndex(true)
                      setRebuildIndexProgress(null)
                      try {
                        for await (const ev of rebuildChatIndex(currentSpaceId!)) {
                          if (ev.processing !== undefined) setRebuildIndexProgress(`${ev.processing}/${ev.total}`)
                          if (ev.done) fetchChatIndexStatus(currentSpaceId!).then(setChatIndexStatus).catch(() => {})
                        }
                      } finally {
                        setRebuildingIndex(false)
                        setRebuildIndexProgress(null)
                      }
                    }}
                    disabled={rebuildingIndex}
                    className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50 whitespace-nowrap"
                  >
                    {rebuildingIndex
                      ? (rebuildIndexProgress ? `Indexing (${rebuildIndexProgress})` : 'Starting…')
                      : 'Rebuild index'}
                  </button>
                </div>
              )}

              {(() => {
                const spaceChats = sessions.filter(s => s.spaceId === currentSpaceId)
                const filtered = spaceChats.filter(s => !sessionSearch || s.title.toLowerCase().includes(sessionSearch.toLowerCase()))
                return (
                  <>
                    <input
                      type="search"
                      placeholder="Search chats…"
                      value={sessionSearch}
                      onChange={e => setSessionSearch(e.target.value)}
                      className="px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
                    />
                    {filtered.length === 0 ? (
                      <p className="text-gray-500 text-sm">{spaceChats.length === 0 ? 'No chats in this space yet.' : 'No chats match your search.'}</p>
                    ) : filtered.map(s => {
                const spaceName = spaces.find(sp => sp.id === s.spaceId)?.name ?? null
                return (
                  <div key={s.id} className="flex items-center gap-2 group">
                    <button
                      onClick={() => loadSession(s.id, s.title)}
                      className="flex-1 text-left px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-100"
                    >
                      {s.title}
                    </button>
                    <div className="relative shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); setSpacePickerOpen(prev => prev === s.id ? null : s.id) }}
                        className="px-2 py-1 rounded text-xs text-indigo-400 bg-indigo-900/40"
                        title="Move to space"
                      >
                        {spaceName}
                      </button>
                      {spacePickerOpen === s.id && (
                        <div className="absolute right-0 top-full mt-1 z-10 bg-gray-800 border border-gray-700 rounded shadow-lg min-w-36 py-1" onClick={e => e.stopPropagation()}>
                          {spaces.map(sp => (
                            <button
                              key={sp.id}
                              onClick={() => handleAssignToSpace(s.id, sp.id)}
                              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 ${s.spaceId === sp.id ? 'text-indigo-400' : 'text-gray-300'}`}
                            >
                              {sp.name}
                            </button>
                          ))}
                          <button
                            onClick={() => { recreateChatMemories(s.id).catch(() => {}); setSpacePickerOpen(null) }}
                            className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-200 border-t border-gray-700 mt-1 pt-1"
                          >
                            Recreate memories
                          </button>
                          <button
                            onClick={() => handleAssignToSpace(s.id, null)}
                            className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-700 hover:text-red-400"
                          >
                            Remove from space
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
                  </>
                )
              })()}
            </div>
          ) : (
            <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-3">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-semibold text-gray-200">Spaces</h2>
                {!newSpaceOpen && (
                  <button
                    onClick={() => setNewSpaceOpen(true)}
                    className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium whitespace-nowrap"
                  >
                    + New space
                  </button>
                )}
              </div>
              {newSpaceOpen && (
                <div className="flex gap-2 items-center">
                  <input
                    autoFocus
                    type="text"
                    value={newSpaceDraft}
                    onChange={e => setNewSpaceDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreateSpace(); if (e.key === 'Escape') { setNewSpaceOpen(false); setNewSpaceDraft('') } }}
                    onBlur={handleCreateSpace}
                    placeholder="Space name…"
                    className="flex-1 px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
              )}
              {spaces.length === 0 && !newSpaceOpen ? (
                <p className="text-gray-500 text-sm">No spaces yet.</p>
              ) : spaces.map(sp => (
                <div key={sp.id} className="flex items-center gap-2 group">
                  <button
                    onClick={() => setCurrentSpaceId(sp.id)}
                    className="flex-1 text-left px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-100"
                  >
                    {sp.name}
                    <span className="ml-2 text-xs text-gray-500">{sp.chatCount} chat{sp.chatCount !== 1 ? 's' : ''}{sp.memoryCount > 0 ? ` · ${sp.memoryCount} memor${sp.memoryCount !== 1 ? 'ies' : 'y'}` : ''}</span>
                  </button>
                  <button
                    onClick={(e) => handleDeleteSpace(sp.id, e)}
                    className="px-2 py-2 text-gray-600 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
                    aria-label={`Delete space "${sp.name}"`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )
        ) : view === 'files' ? (
          <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold text-gray-200">Knowledge base</h2>
                <p className="text-xs text-gray-500 max-w-lg">
                  Files here are chunked, embedded, and searched automatically whenever your query
                  might be answered by their content — no need to reference them explicitly.
                  To ask about a specific file without storing it, use the paperclip in the chat input instead.
                  Supported: PDF, plain text, images.
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <button
                  onClick={() => kbFileRef.current?.click()}
                  disabled={kbUploadStatus === 'uploading'}
                  className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium whitespace-nowrap"
                >
                  {kbUploadStatus === 'uploading' ? 'Uploading…' : '+ Upload file'}
                </button>
                {kbUploadStatus !== 'idle' && (
                  <span className={`text-xs ${kbUploadStatus === 'error' ? 'text-red-400' : 'text-green-400'}`}>
                    {kbUploadMsg}
                  </span>
                )}
                <input ref={kbFileRef} type="file" className="hidden" onChange={handleKbUpload} />
              </div>
            </div>
            {files.length === 0 ? (
              <p className="text-gray-500 text-sm">No files uploaded yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {files.map(f => (
                  <div key={f.id} className="flex items-center gap-3 group px-4 py-3 rounded-lg bg-gray-800">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-100 truncate">{f.filename}</div>
                      <div className="text-xs text-gray-500">{formatSize(f.size)} · {f.mimeType} · {new Date(f.createdAt * 1000).toLocaleDateString()}</div>
                    </div>
                    <button
                      onClick={(e) => handleDeleteFile(f.id, e)}
                      className="text-xs text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : view === 'monitors' ? (
          <MonitorsView
            spaces={spaces}
            isAdmin={currentUser?.role === 'admin'}
            timezone={currentUser?.settings?.timezone ?? ''}
            onCountChange={setMonitorCount}
            onOpenSession={(id, title) => { loadSession(id, title, false); setSidebarOpen(false) }}
          />
        ) : (
          <>
            {sessionId && (() => {
              const title = sessions.find(s => s.id === sessionId)?.title ?? ''
              return (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 min-h-[2.5rem]">
                  {editingTitle ? (
                    <input
                      autoFocus
                      value={titleDraft}
                      onChange={e => setTitleDraft(e.target.value)}
                      onBlur={handleTitleSave}
                      onKeyDown={e => { if (e.key === 'Enter') handleTitleSave(); if (e.key === 'Escape') setEditingTitle(false) }}
                      className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                    />
                  ) : (
                    <>
                      <span className="flex-1 text-sm text-gray-400 truncate">{title}</span>
                      {spaces.length > 0 && sessionId && (() => {
                        const session = sessions.find(s => s.id === sessionId)
                        const spaceName = session?.spaceId ? spaces.find(sp => sp.id === session.spaceId)?.name : null
                        const pickerId = `heading-${sessionId}`
                        return (
                          <div className="relative shrink-0 flex items-center gap-1">
                            {spaceName && session?.spaceId && (
                              <button
                                onClick={() => { setCurrentSpaceId(session.spaceId!); setView('spaces') }}
                                className="text-xs px-2 py-0.5 rounded text-indigo-400 bg-indigo-900/40 hover:bg-indigo-800/60"
                                title={`Go to space: ${spaceName}`}
                              >
                                {spaceName} ↗
                              </button>
                            )}
                            <button
                              onClick={() => setSpacePickerOpen(prev => prev === pickerId ? null : pickerId)}
                              className="text-xs px-1.5 py-0.5 rounded text-gray-600 hover:text-gray-400"
                              title="Assign to space"
                            >
                              ⊡
                            </button>
                            {spacePickerOpen === pickerId && (
                              <div className="absolute right-0 top-full mt-1 z-10 bg-gray-800 border border-gray-700 rounded shadow-lg min-w-36 py-1">
                                {spaces.map(sp => (
                                  <button
                                    key={sp.id}
                                    onClick={() => { handleAssignToSpace(sessionId, sp.id); setSpacePickerOpen(null) }}
                                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 ${session?.spaceId === sp.id ? 'text-indigo-400' : 'text-gray-300'}`}
                                  >
                                    {sp.name}
                                  </button>
                                ))}
                                {session?.spaceId && (
                                  <button
                                    onClick={() => { handleAssignToSpace(sessionId, null); setSpacePickerOpen(null) }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-700 hover:text-red-400 border-t border-gray-700 mt-1 pt-1"
                                  >
                                    Remove from space
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                      <button
                        onClick={() => { setTitleDraft(title); setEditingTitle(true) }}
                        className="text-xs text-gray-600 hover:text-gray-400 shrink-0"
                        aria-label="Edit title"
                      >
                        ✎
                      </button>
                    </>
                  )}
                </div>
              )
            })()}
            {messages.length === 0 && !streaming ? (
              <div className="flex flex-col items-center justify-center flex-1 gap-3 text-gray-500">
                <img src="/logo.webp" alt="Queriocity" className="w-24 sm:w-32 md:w-40 h-auto" />
                <span className="text-2xl font-semibold text-gray-300">Queriocity</span>
                <span className="text-sm">LLM-driven web search</span>
              </div>
            ) : (
              <MessageList messages={messages} streaming={streaming} streamingThinking={streamingThinking} />
            )}
            {status && (
              <div className="px-4 py-1 text-xs text-gray-500 italic animate-pulse">{status}</div>
            )}
            {answerTime && !busy && (
              <div className="px-4 py-1 text-xs text-gray-500">{answerTime}</div>
            )}
            {sessionId && messages.length > 0 && !busy && (
              <div className="px-4 py-1 relative flex items-center">
                <div className="relative">
                  <button
                    onClick={() => setExportOpen(o => !o)}
                    onBlur={e => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) setExportOpen(false) }}
                    className="text-xs text-gray-600 hover:text-gray-400 flex items-center gap-0.5"
                  >
                    Export ▾
                  </button>
                  {exportOpen && (
                    <div className="absolute bottom-full mb-1 left-0 bg-gray-800 border border-gray-700 rounded shadow-lg z-10 py-1 min-w-max">
                      <button onMouseDown={() => handleExport('full')} className="block w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-gray-700">
                        Download full chat (.md)
                      </button>
                      <button onMouseDown={() => handleExport('last')} className="block w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-gray-700">
                        Download last answer (.md)
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
            {focusMode === 'thorough' && currentUser?.settings?.useThinking && (
              <div className="px-4 py-0.5 text-xs text-purple-400 opacity-70">⬡ Model thinking active</div>
            )}
            <ChatInput
              onSubmit={submit}
              onCancel={cancel}
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
