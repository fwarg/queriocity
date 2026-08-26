import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { BookOpen, RotateCcw, Lock, ShieldCheck, Trash2, X } from 'lucide-react'
import { MessageList, ImageCaptionContext } from './components/MessageList.tsx'
import { ProgressLog, Elapsed } from './components/ProgressLog.tsx'
import { ApprovalPrompt } from './components/ApprovalPrompt.tsx'
import { ChatInput } from './components/ChatInput.tsx'
import { LoginPage } from './components/LoginPage.tsx'
import { RegisterPage } from './components/RegisterPage.tsx'
import { SettingsPanel } from './components/SettingsPanel.tsx'
import { AdminPanel } from './components/AdminPanel.tsx'
import { MonitorsView } from './components/MonitorsView.tsx'
import { ChatRow } from './components/ChatRow.tsx'
import { useConfirm } from './components/confirm.tsx'
import { useGuide, useGuideNavigation } from './components/GuideView.tsx'
import type { GuideTarget } from '@shared/guide/index.ts'
import { EmptyState, PRIMARY_BTN, RowAction } from './components/ui.tsx'
import { SectionHeader } from './components/SectionHeader.tsx'
import { SpacesView } from './components/SpacesView.tsx'
import { ResourcesView } from './components/ResourcesView.tsx'
import {
  fetchHistory, fetchSession, deleteSession, updateSessionTitle,
  fetchFiles, getMe, hasUsers, logout,
  fetchSpaces, createSpace, promoteCollection, updateSpace, deleteSpace, assignChatToSpace, recreateChatMemories,
  fetchSpaceMemories, createSpaceMemory, updateSpaceMemory, deleteSpaceMemory, compactSpaceMemories, recreateAllSpaceMemories, clearSpaceMemories,
  fetchChatIndexStatus, rebuildChatIndex, searchHistory,
  fetchSpaceFiles, tagFileToSpace, untagFileFromSpace, transformSpace,
  fetchMonitors,
} from './lib/api.ts'
import type { AuthUser, Message, Resource, Space, SpaceKind, SpaceMemory, SpaceFile } from './lib/api.ts'
import { useChat } from './hooks/useChat.ts'
import { useLang, useT } from './lib/i18n.tsx'

/** One per mode worth showing off: something current, something comparative, something explained. */
const EXAMPLE_KEYS = ['guide.example1', 'guide.example2', 'guide.example3'] as const

type AuthView = 'loading' | 'login' | 'register'
type MainView = 'chat' | 'chats' | 'files' | 'spaces' | 'monitors'
type Session = { id: string; title: string; spaceId: string | null; locked?: boolean }

const MEMORY_HEADER_TOKENS = 30

/** How many memories will not fit the per-request budget. They are no longer *excluded* — the
 *  server picks the most relevant ones per query — so this is a "not all at once" hint, not a
 *  warning that the tail is unreachable. */
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
  const t = useT()
  const confirm = useConfirm()
  const openGuide = useGuide()
  const { lang, setLang } = useLang()
  const [authView, setAuthView] = useState<AuthView>('loading')
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [inviteToken, setInviteToken] = useState<string | undefined>()

  const [focusMode, setFocusMode] = useState<'flash' | 'balanced' | 'thorough' | 'image'>('balanced')
  const [searchCategories, setSearchCategories] = useState<Array<'news' | 'science' | 'discussions' | 'tech'>>([])
  /** Collections picked for the next message — per request, never stored on the chat.
   *
   *  Held here rather than in ChatInput, which remounts per session, so a selection survives asking
   *  several questions in a row. It also survives switching chats, which is deliberate: the chips
   *  are visibly lit, so an unwanted one is obvious and one click away, whereas silently clearing a
   *  shelf the user had set up would be the more surprising of the two. */
  const [selectedCollections, setSelectedCollections] = useState<string[]>([])

  const [sessionId, setSessionId] = useState<string | undefined>()
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [files, setFiles] = useState<Resource[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  /** Message from a refused lock change or chat move — both are server decisions the user cannot
   *  predict from the UI alone, so the reason has to be surfaced rather than silently reverted. */
  const [spaceError, setSpaceError] = useState<string | null>(null)
  const [monitorCount, setMonitorCount] = useState(0)
  const [isMonitorSession, setIsMonitorSession] = useState(false)
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [chatSearchCursor, setChatSearchCursor] = useState(0)
  const chatSearchInputRef = useRef<HTMLInputElement>(null)
  const [currentSpaceId, setCurrentSpaceId] = useState<string | null>(null)
  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null)
  const [spaceDraft, setSpaceDraft] = useState('')
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
  const [pinnedFileIds, setPinnedFileIds] = useState<string[]>([])
  const [pinnedMemoryIds, setPinnedMemoryIds] = useState<string[]>([])
  /** Chats belonging to the open space, fetched server-side. `null` while loading. */
  const [spaceChats, setSpaceChats] = useState<Session[] | null>(null)
  const [transformStatus, setTransformStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [transformError, setTransformError] = useState('')
  const [compacting, setCompacting] = useState(false)
  const [compactResult, setCompactResult] = useState<string | null>(null)
  const [recreating, setRecreating] = useState(false)
  const [recreateProgress, setRecreateProgress] = useState<string | null>(null)
  const [view, setView] = useState<MainView>('chat')
  // Which resource's detail panel is open in the Resources view. Lives here rather than inside
  // ResourcesView so a chat citation's [F1]/[C1] reference can open one directly from outside it.
  const [openResourceId, setOpenResourceId] = useState<string | null>(null)
  const openResource = useCallback((id: string) => {
    setOpenResourceId(id)
    setView('files')
    setSidebarOpen(false)
  }, [])
  const [showSettings, setShowSettings] = useState(false)
  const [showAdmin, setShowAdmin] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [chatSort, setChatSort] = useState<'updated' | 'created'>('updated')
  const [chatSearch, setChatSearch] = useState('')
  const [chatSearchResults, setChatSearchResults] = useState<Session[] | null>(null)
  const [chatTotal, setChatTotal] = useState(0)

  // The guide's "Open Spaces →" buttons. Registered rather than passed, because the guide is
  // mounted above App so that any view's ⓘ can open it.
  useGuideNavigation(useCallback((target: GuideTarget) => {
    if (target === 'settings') { setShowSettings(true); return }
    if (target === 'spaces') setCurrentSpaceId(null)
    if (target === 'files') setOpenResourceId(null)
    setView(target)
    setSidebarOpen(false)
  }, []))
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

  // Advisory only — the server decides this from the database on every request. This drives the
  // banner and the disabled controls, so a stale value degrades the UI, never the guarantee.
  const activeSpaceLocked = !!activeSpaceId && spaces.some(s => s.id === activeSpaceId && s.offline)
  const spaceIsLocked = (id: string | null | undefined) => !!id && spaces.some(sp => sp.id === id && sp.offline)
  const activeSpaceIsCollection = spaces.some(sp => sp.id === currentSpaceId && sp.kind === 'collection')
  /** Only spaces can hold a chat, so only spaces are offered as a destination for one. The server
   *  refuses a collection either way; this keeps the UI from proposing what it will refuse. */
  const chatSpaces = spaces.filter(sp => sp.kind === 'space')

  const { messages, setMessages, streaming, streamingThinking, status, setStatus, answerTime, busy, submit, regenerate, cancel, reset, related, setRelated, steps, runStartedAt, approval, decideApproval } = useChat({
    sessionId,
    focusMode,
    searchCategories,
    includeFileIds: pinnedFileIds.length ? pinnedFileIds : undefined,
    collectionIds: selectedCollections.length ? selectedCollections : undefined,
    includeMemoryIds: pinnedMemoryIds.length ? pinnedMemoryIds : undefined,
    spaceId: activeSpaceId ?? undefined,
    followUpSuggestions: currentUser?.settings?.followUpSuggestions !== false,
    onSessionCreated: (id, title) => {
      setSessionId(id)
      setSessions(prev => prev.some(s => s.id === id) ? prev : [{ id, title, spaceId: activeSpaceId }, ...prev])
      if (activeSpaceId) {
        setSpaces(sps => sps.map(sp => sp.id === activeSpaceId ? { ...sp, chatCount: sp.chatCount + 1 } : sp))
        fetchSpaceMemories(activeSpaceId).then(({ memories }) => setSpaceMemories(memories)).catch(() => {})
        if (activeSpaceId === currentSpaceId) {
          setSpaceChats(prev => prev && prev.some(s => s.id === id) ? prev : [{ id, title, spaceId: activeSpaceId }, ...(prev ?? [])])
        }
      }
    },
  })

  const bottomRef = useRef<HTMLDivElement>(null)

  // The signed-in setting wins over the browser guess the provider started from. One-way: the
  // provider never writes back to user settings, so this cannot loop against the PATCH below.
  const userLang = currentUser?.settings?.language
  useEffect(() => { if (userLang) setLang(userLang) }, [userLang, setLang])

  const fontSize = currentUser?.settings?.fontSize ?? 17
  useEffect(() => {
    const boost = 2
    document.documentElement.style.fontSize =
      `clamp(${fontSize}px, calc(${fontSize}px + ${boost} * (1440px - 100vw) / 1065), ${fontSize + boost}px)`
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
        fetchMonitors().then(ms => setMonitorCount(ms.length)).catch(() => {})
      } else if (token) {
        setAuthView('register')
      } else {
        hasUsers().then(exists => setAuthView(exists ? 'login' : 'register'))
      }
    })
  }, [])

  useEffect(() => {
    setPinnedFileIds([])
    setPinnedMemoryIds([])
    if (currentSpaceId) fetchSpaceFiles(currentSpaceId).then(setTaggedFiles).catch(() => {})
    else setTaggedFiles([])
    // Chats, memories and the chat index describe conversations, which a collection has none of.
    // `activeSpaceIsCollection` is a dependency so promotion fills them in without reopening.
    if (currentSpaceId && !activeSpaceIsCollection) {
      fetchSpaceMemories(currentSpaceId).then(({ memories }) => { setSpaceMemories(memories) }).catch(() => {})
      fetchChatIndexStatus(currentSpaceId).then(setChatIndexStatus).catch(() => {})
      // Fetched per space rather than filtered out of `sessions`: that array holds only the most
      // recent page, so a space with no recently-updated chats would look empty.
      setSpaceChats(null)
      fetchHistory(chatSort, 0, currentSpaceId)
        .then(({ items }) => setSpaceChats(items))
        .catch(() => setSpaceChats([]))
    } else {
      setSpaceMemories([])
      setChatIndexStatus(null)
      setSpaceChats(null)
      setPinnedFileIds([])
      setPinnedMemoryIds([])
    }
    setMemorySectionOpen(false)
    setFilesSectionOpen(false)
    setFilePickerOpen(false)
    setNewMemoryOpen(false)
    setCompactResult(null)
    setRecreateProgress(null)
  }, [currentSpaceId, activeSpaceIsCollection])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    // `steps` included: the progress log grows below the last message, so without it the log
    // is pushed off the bottom of a long conversation exactly when it is worth reading.
  }, [messages, streaming, steps])

  const chatMatchIndices = useMemo(() => {
    if (!chatSearchOpen || !chatSearchQuery.trim()) return []
    const q = chatSearchQuery.toLowerCase()
    return messages.reduce<number[]>((acc, msg, i) => {
      if (msg.content.toLowerCase().includes(q)) acc.push(i)
      return acc
    }, [])
  }, [messages, chatSearchQuery, chatSearchOpen])

  // Reset cursor when query or session changes
  useEffect(() => { setChatSearchCursor(0) }, [chatSearchQuery, sessionId])

  // Close search when switching sessions
  useEffect(() => { setChatSearchOpen(false); setChatSearchQuery('') }, [sessionId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && view === 'chat' && messages.length > 0) {
        e.preventDefault()
        setChatSearchOpen(true)
        setTimeout(() => chatSearchInputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, messages.length])

  function handleAuthSuccess(user: AuthUser) {
    setCurrentUser(user)
    setAuthView('loading')
    fetchFiles().then(setFiles).catch(() => {})
    fetchSpaces().then(setSpaces).catch(() => {})
    fetchMonitors().then(ms => setMonitorCount(ms.length)).catch(() => {})
  }

  async function handleLogout() {
    await logout()
    setCurrentUser(null)
    setSessions([])
    setFiles([])
    setSpaces([])
    setMessages([])
    setCurrentSpaceId(null)
    setMonitorCount(0)
    setAuthView('login')
  }


  function loadSession(id: string, title: string, addToHistory = true, fromMonitor = false) {
    setSessionId(id)
    setEditingTitle(false)
    setIsMonitorSession(fromMonitor)
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
    setIsMonitorSession(false)
    reset()
    setCurrentSpaceId(inSpaceId ?? null)
    setView('chat')
  }

  /** Provenance front-matter for exported chats — EU AI Act Art 50(2).
   *
   *  Front-matter rather than an embedded watermark: no interoperable machine-readable marking
   *  exists for plain text, and Queriocity does not control the model, so it cannot apply one at
   *  generation time. This records the fact where a parser can find it. */
  const EXPORT_FRONT_MATTER = [
    '---',
    'generator: Queriocity',
    'ai_generated: true',
    'digital_source_type: http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
    'note: Assistant turns were generated by an AI language model and may contain errors.',
    '---',
    '',
  ].join('\n')

  function buildSessionMarkdown(msgs: Message[], title: string, scope: 'full' | 'last'): string {
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const header = `${EXPORT_FRONT_MATTER}# ${title}\n_Exported: ${date}_\n\n`
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
    setSpaceChats(prev => prev?.map(s => s.id === sessionId ? { ...s, title: trimmed } : s) ?? prev)
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

  /** Print the chat by cloning the message list into a detached container — see index.css.
   *  Printing in place would capture only what the scroll container currently shows. */
  function handlePrint() {
    setExportOpen(false)
    const region = document.querySelector('[data-print-region]')
    if (!region) return
    document.getElementById('print-root')?.remove()

    const holder = document.createElement('div')
    holder.id = 'print-root'
    const heading = document.createElement('h1')
    heading.textContent = sessions.find(s => s.id === sessionId)?.title ?? t('chat.untitled')
    const date = document.createElement('div')
    date.className = 'print-date'
    date.textContent = new Date().toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric' })
    // Visible AI disclosure on paper, where none of the on-screen cues survive.
    const notice = document.createElement('div')
    notice.className = 'print-ai-notice'
    notice.textContent = t('notice.printExport')
    holder.append(heading, date, region.cloneNode(true), notice)
    document.body.append(holder)
    document.body.classList.add('printing')

    const cleanup = () => {
      holder.remove()
      document.body.classList.remove('printing')
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    window.print()
  }

  /** `e` only from the sidebar row, whose own click opens the chat. RowAction stops it itself. */
  async function handleDeleteSession(id: string, e?: React.MouseEvent) {
    e?.stopPropagation()
    if (!await confirm({ message: t('chat.deleteConfirm'), confirmLabel: t('common.delete'), danger: true })) return
    deleteSession(id).then(() => {
      // The chat may be listed only in the open space's list, so resolve its space from either.
      const spaceOfChat = sessions.find(s => s.id === id)?.spaceId
        ?? spaceChats?.find(s => s.id === id)?.spaceId
        ?? null
      if (spaceOfChat) {
        setSpaces(sps => sps.map(sp => sp.id === spaceOfChat ? { ...sp, chatCount: Math.max(0, sp.chatCount - 1) } : sp))
      }
      setSessions(prev => prev.filter(x => x.id !== id))
      setSpaceChats(prev => prev?.filter(x => x.id !== id) ?? prev)
      if (sessionId === id) newChat()
    }).catch(() => setStatus(t('chat.deleteFailed')))
  }

  function handleCreateSpace(name: string, kind: SpaceKind) {
    createSpace(name, kind).then(s => setSpaces(prev => [...prev, s])).catch(() => {})
  }

  /** One-way, and stated as such before it happens: the server refuses the reverse. */
  async function handlePromoteCollection() {
    if (!currentSpaceId) return
    if (!await confirm({ message: t('collection.promoteTitle'), confirmLabel: t('collection.promote'), danger: true })) return
    promoteCollection(currentSpaceId)
      .then(() => fetchSpaces().then(setSpaces))
      .catch(err => setSpaceError(err instanceof Error ? err.message : t('collection.promoteFailed')))
  }

  async function handleDeleteSpace(id: string) {
    const sp = spaces.find(s => s.id === id)
    const label = sp ? `"${sp.name}"` : t('space.thisSpace')
    // A locked space takes its chats with it. Unassigning them instead would turn every one into an
    // ordinary chat with web access — the quietest way out of a lock — so the warning has to say
    // plainly that they are destroyed, not moved.
    const warning = sp?.offline
      ? t('space.deleteLockedConfirm', { label, count: sp.chatCount })
      : t('space.deleteConfirm', { label })
    if (!await confirm({ message: warning, confirmLabel: t('common.delete'), danger: true })) return
    deleteSpace(id).then(({ deletedChats }) => {
      setSpaces(prev => prev.filter(s => s.id !== id))
      setSessions(prev => deletedChats > 0
        ? prev.filter(s => s.spaceId !== id)
        : prev.map(s => s.spaceId === id ? { ...s, spaceId: null } : s))
      if (currentSpaceId === id) setCurrentSpaceId(null)
    }).catch(() => {})
  }

  /** Lock or unlock a space.
   *
   *  Locking a space that already holds something is confirmed first: it is not a leak risk, but it
   *  cannot be undone afterwards without deleting the contents, and a toggle that silently becomes
   *  permanent is a trap. Unlocking is decided by the server, which refuses while anything remains. */
  async function handleToggleSpaceLock(id: string) {
    const sp = spaces.find(s => s.id === id)
    if (!sp) return
    const next = !sp.offline
    if (next) {
      const holds = [
        sp.chatCount ? t('space.holdsChats', { count: sp.chatCount }) : '',
        sp.memoryCount ? t('space.holdsMemories', { count: sp.memoryCount }) : '',
      ].filter(Boolean).join(t('common.and'))
      const msg = holds
        ? t('space.lockConfirmHolding', { name: sp.name, holds })
        : t('space.lockConfirmEmpty', { name: sp.name })
      if (!await confirm({ message: msg, confirmLabel: t('space.lockAction'), danger: true })) return
    }
    setSpaces(prev => prev.map(s => s.id === id ? { ...s, offline: next } : s))
    updateSpace(id, { offline: next }).then(res => {
      if (res.ok) return
      setSpaces(prev => prev.map(s => s.id === id ? { ...s, offline: !next } : s))
      setSpaceError(res.error ?? t('space.lockChangeFailed'))
    }).catch(() => {})
  }

  function handleSpaceRenameSave(id: string) {
    const name = spaceDraft.trim()
    setEditingSpaceId(null)
    if (!name) return
    setSpaces(prev => prev.map(s => s.id === id ? { ...s, name } : s))
    updateSpace(id, { name }).catch(() => {})
  }

  function handleAssignToSpace(chatId: string, spaceId: string | null) {
    // Look in both lists: a chat shown in the open space may be outside the loaded history page,
    // and reading only `sessions` would mistake its old space for "none" and skew the counts.
    const moved = sessions.find(s => s.id === chatId) ?? spaceChats?.find(s => s.id === chatId)
    const prevSpaceId = moved?.spaceId ?? null
    if (prevSpaceId === spaceId) { setSpacePickerOpen(null); return }

    setSessions(prev => prev.map(s => s.id === chatId ? { ...s, spaceId } : s))
    setSpaceChats(prev => {
      if (prev === null) return prev
      if (spaceId === currentSpaceId && moved) {
        return prev.some(s => s.id === chatId) ? prev : [{ ...moved, spaceId }, ...prev]
      }
      return prev.filter(s => s.id !== chatId)
    })
    setSpaces(prev => prev.map(sp => {
      if (sp.id === prevSpaceId) return { ...sp, chatCount: Math.max(0, sp.chatCount - 1) }
      if (sp.id === spaceId) return { ...sp, chatCount: sp.chatCount + 1 }
      return sp
    }))
    setSpacePickerOpen(null)
    // The move can be refused: a chat in a locked space may only go to another locked space.
    // The optimistic update above has to be undone rather than left showing a move that never
    // happened, which would misreport where a sensitive chat lives.
    assignChatToSpace(chatId, spaceId).then(res => {
      if (res.ok) return
      setSessions(prev => prev.map(s => s.id === chatId ? { ...s, spaceId: prevSpaceId } : s))
      setSpaceChats(prev => {
        if (prev === null) return prev
        if (prevSpaceId === currentSpaceId && moved) {
          return prev.some(s => s.id === chatId) ? prev : [{ ...moved, spaceId: prevSpaceId }, ...prev]
        }
        return prev.filter(s => s.id !== chatId)
      })
      setSpaces(prev => prev.map(sp => {
        if (sp.id === spaceId) return { ...sp, chatCount: Math.max(0, sp.chatCount - 1) }
        if (sp.id === prevSpaceId) return { ...sp, chatCount: sp.chatCount + 1 }
        return sp
      }))
      setSpaceError(res.error ?? t('chat.moveFailed'))
    }).catch(() => {})
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
    updateSpaceMemory(currentSpaceId, id, { content }).catch(() => {})
  }

  function handleMemoryAlwaysKeep(id: string, alwaysKeep: boolean) {
    if (!currentSpaceId) return
    setSpaceMemories(prev => prev.map(m => m.id === id ? { ...m, alwaysKeep } : m))
    updateSpaceMemory(currentSpaceId, id, { alwaysKeep }).catch(() => {})
  }

  async function handleTransform() {
    if (!currentSpaceId) return
    setTransformStatus('loading')
    setTransformError('')
    try {
      const fileIds = pinnedFileIds.length ? pinnedFileIds : undefined
      await transformSpace(currentSpaceId, 'summarize', fileIds)
      fetchSpaceMemories(currentSpaceId).then(({ memories }) => setSpaceMemories(memories)).catch(() => {})
      setTransformStatus('idle')
    } catch (err: unknown) {
      setTransformStatus('error')
      setTransformError(err instanceof Error ? err.message : t('space.transformFailed'))
      setTimeout(() => setTransformStatus('idle'), 5000)
    }
  }

  /** ResourcesView mutates the library; the list stays here because the space panel tags from it. */
  const reloadFiles = useCallback(() => { fetchFiles().then(setFiles).catch(() => {}) }, [])

  // Auth screens
  if (authView === 'loading' && !currentUser) {
    return <div className="flex h-screen items-center justify-center text-gray-500 text-sm">{t('common.loading')}</div>
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
    <>
    <div className="flex h-screen">
      {currentUser?.mustChangePassword && !showSettings && (
        <div className="fixed top-0 inset-x-0 z-50 bg-amber-900/90 text-amber-100 text-sm px-4 py-2 flex items-center justify-center gap-3">
          <span>{t('auth.tempPasswordBanner')}</span>
          <button
            onClick={() => setShowSettings(true)}
            className="px-2 py-0.5 rounded bg-amber-700 hover:bg-amber-600 text-xs font-medium"
          >
            {t('settings.changePassword')}
          </button>
        </div>
      )}
      {showSettings && currentUser && (
        <SettingsPanel
          customPrompt={currentUser.settings?.customPrompt ?? ''}
          showThinking={currentUser.settings?.showThinking ?? { balanced: false, thorough: false }}
          useThinking={currentUser.settings?.useThinking ?? false}
          useSpaceRag={currentUser.settings?.useSpaceRag !== false}
          useChatRag={currentUser.settings?.useChatRag !== false}
          querySuggestions={currentUser.settings?.querySuggestions !== false}
          followUpSuggestions={currentUser.settings?.followUpSuggestions !== false}
          userMemory={currentUser.settings?.userMemory === true}
          imageWatermark={currentUser.settings?.imageWatermark !== false}
          fontSize={currentUser.settings?.fontSize ?? 17}
          timezone={currentUser.settings?.timezone ?? ''}
          onClose={() => setShowSettings(false)}
          onPasswordChanged={() => setCurrentUser(u => u ? { ...u, mustChangePassword: false } : u)}
          onSave={s => {
            setCurrentUser(u => u ? { ...u, settings: { ...u.settings, ...s } } : u)
            // Chips already on screen would otherwise linger until the next answer.
            if (!s.followUpSuggestions) setRelated([])
          }}
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
          + {t('chat.new')}
        </button>
        <button
          onClick={() => { setView(v => v === 'chats' ? 'chat' : 'chats'); setSidebarOpen(false) }}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'chats' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          {t('nav.chats')} ({chatTotal || sessions.length})
        </button>
        <button
          onClick={() => { setView(v => v === 'files' ? 'chat' : 'files'); setOpenResourceId(null); setSidebarOpen(false) }}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'files' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          {t('nav.resources')} ({files.length})
        </button>
        <button
          onClick={() => { setView(v => v === 'spaces' ? 'chat' : 'spaces'); setCurrentSpaceId(null); setSidebarOpen(false) }}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'spaces' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          {t('nav.workspaces')} ({spaces.length})
        </button>
        <button
          onClick={() => { setView(v => v === 'monitors' ? 'chat' : 'monitors'); setSidebarOpen(false) }}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'monitors' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
        >
          {t('nav.monitors')} ({monitorCount})
        </button>
        <div className="border-t border-gray-800 my-1" />
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
          {sessions.length > 5 && (
            <input
              type="search"
              placeholder={t('chat.searchPlaceholder')}
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
              <RowAction
                icon={<Trash2 size={14} />}
                tone="danger"
                persistent
                label={t('chat.deleteNamed', { title: s.title })}
                onClick={() => handleDeleteSession(s.id)}
              />
            </div>
          ))}
          <div ref={sidebarSentinelRef} className="py-1 text-center text-xs text-gray-600">
            {chatLoadingMore ? t('common.loading') : ''}
          </div>
        </div>

        {/* Bottom user area */}
        <div className="border-t border-gray-800 pt-2 flex flex-col gap-1">
          <button onClick={() => { openGuide(); setSidebarOpen(false) }} className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800 flex items-center gap-1.5">
            <BookOpen size={12} /> {t('nav.guide')}
          </button>
          <button onClick={() => { setShowSettings(true); setSidebarOpen(false) }} className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800">
            ⚙ {t('nav.settings')}
          </button>
          {currentUser?.role === 'admin' && (
            <button onClick={() => { setShowAdmin(true); setSidebarOpen(false) }} className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800">
              ◈ {t('nav.admin')}
            </button>
          )}
          <button onClick={handleLogout} className="w-full text-left px-3 py-2 rounded text-xs text-gray-500 hover:bg-gray-800 hover:text-red-400">
            {t('nav.signOut')} — {currentUser?.name ?? currentUser?.email}
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
            aria-label={t('nav.openMenu')}
          >
            ☰
          </button>
          <span className="font-semibold text-white text-sm">Queriocity</span>
        </div>
        {view === 'chats' ? (
          <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-3" onClick={() => setSpacePickerOpen(null)}>
            <div className="mb-2">
            <SectionHeader title={t('nav.chats')} intro={t('chat.intro')} about={t('chat.aboutTitle')} topic="gettingStarted">
              {!chatSearchResults && (
                <div className="flex items-center gap-1 text-xs">
                  <button onClick={() => setChatSort('updated')} className={chatSort === 'updated' ? 'text-indigo-400' : 'text-gray-500 hover:text-gray-300'}>{t('chat.sortActive')}</button>
                  <span className="text-gray-700">·</span>
                  <button onClick={() => setChatSort('created')} className={chatSort === 'created' ? 'text-indigo-400' : 'text-gray-500 hover:text-gray-300'}>{t('chat.sortCreated')}</button>
                </div>
              )}
            </SectionHeader>
            </div>
            <input
              type="search"
              placeholder={t('chat.searchAllPlaceholder')}
              value={chatSearch}
              onChange={e => setChatSearch(e.target.value)}
              className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none focus:border-indigo-500 mb-1"
            />
            {chatSearchResults !== null && (
              <p className="text-xs text-gray-500 mb-1">
                {chatSearchResults.length === 0 ? t('common.noResults') : t('common.results', { count: chatSearchResults.length })}
              </p>
            )}
            {(chatSearchResults ?? sessions).length === 0 && !chatSearch ? (
              <EmptyState>{t('chat.noneSaved')}</EmptyState>
            ) : (chatSearchResults ?? sessions).map(s => (
              <ChatRow
                key={s.id}
                chat={s}
                spaceName={s.spaceId ? spaces.find(sp => sp.id === s.spaceId)?.name ?? null : null}
                chatSpaces={chatSpaces}
                spaceIsLocked={spaceIsLocked}
                pickerOpen={spacePickerOpen === s.id}
                onOpen={() => loadSession(s.id, s.title)}
                onTogglePicker={() => setSpacePickerOpen(prev => prev === s.id ? null : s.id)}
                onAssign={spaceId => handleAssignToSpace(s.id, spaceId)}
                onDelete={() => handleDeleteSession(s.id)}
              />
            ))}
            {!chatSearchResults && (
              <div ref={sentinelRef} className="py-1 text-center text-xs text-gray-600">
                {chatLoadingMore ? t('common.loading') : ''}
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
                  ← {t('nav.workspaces')}
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
                      aria-label={t('space.rename')}
                    >
                      ✎
                    </button>
                  </h2>
                )}
                {activeSpaceIsCollection ? (
                  <button
                    onClick={handlePromoteCollection}
                    title={t('collection.promoteTitle')}
                    className="ml-auto px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
                  >
                    {t('collection.promote')}
                  </button>
                ) : (
                  <button
                    onClick={() => newChat(currentSpaceId!)}
                    className={`ml-auto ${PRIMARY_BTN}`}
                  >
                    + {t('chat.new')}
                  </button>
                )}
              </div>
              {/* Memory describes conversations, which a collection has none of — as do the chat
                  index and the chat list further down, each guarded the same way because the
                  resources section sits between them. Resources are the whole of a collection. */}
              {!activeSpaceIsCollection && <>
              {/* Memory section */}
              <div className="border border-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setMemorySectionOpen(o => !o)}
                    className="flex items-center gap-1.5 text-sm font-medium text-gray-400 hover:text-gray-200"
                  >
                    <span>{memorySectionOpen ? '▾' : '▸'}</span>
                    {t('memory.section', { count: spaceMemories.length })}
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
                              setCompactResult(compacted ? `${before} → ${after}` : t('memory.alreadyCompact'))
                              setTimeout(() => setCompactResult(null), 4000)
                            } finally {
                              setCompacting(false)
                            }
                          }}
                          disabled={compacting}
                          className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50"
                        >
                          {compacting ? t('memory.compacting') : t('memory.compact')}
                        </button>
                      )}
                      {compactResult && <span className="text-xs text-gray-500">{compactResult}</span>}
                      <button
                        onClick={async () => {
                          if (!await confirm({ message: t('memory.recreateConfirm'), confirmLabel: t('memory.recreateAll'), danger: true })) return
                          setRecreating(true)
                          setRecreateProgress(null)
                          setCompactResult(null)
                          try {
                            for await (const ev of recreateAllSpaceMemories(currentSpaceId!)) {
                              if (ev.processing !== undefined) setRecreateProgress(`${ev.processing}/${ev.total}`)
                              if (ev.done) {
                                fetchSpaceMemories(currentSpaceId!).then(({ memories }) => { setSpaceMemories(memories) }).catch(() => {})
                                if (ev.errors) {
                                  setCompactResult(t('memory.recreateErrors', { count: ev.errors }))
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
                        {recreating ? (recreateProgress ? t('common.processing', { progress: recreateProgress }) : t('common.starting')) : t('memory.recreateAll')}
                      </button>
                      <button
                        onClick={async () => {
                          if (!await confirm({ message: t('memory.clearConfirm'), confirmLabel: t('common.clearAll'), danger: true })) return
                          await clearSpaceMemories(currentSpaceId!)
                          setSpaceMemories([])
                        }}
                        disabled={compacting || recreating}
                        className="text-xs text-gray-500 hover:text-red-400 disabled:opacity-50"
                      >
                        {t('common.clearAll')}
                      </button>
                      <button onClick={() => setNewMemoryOpen(true)} className="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
                    </div>
                  )}
                </div>
                {memorySectionOpen && (() => {
                  const overflow = countOverflowMemories(spaceMemories, currentUser?.memoryTokenBudget ?? 1000)
                  return overflow > 0 ? (
                    <p className="text-xs text-gray-500 mt-1">
                      {t('memory.overflow', { count: overflow })}
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
                      placeholder={t('memory.addPlaceholder')}
                      className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                )}
                {memorySectionOpen && spaceMemories.length === 0 && !newMemoryOpen ? (
                  <p className="text-xs text-gray-600 mt-2">{t('memory.none')}</p>
                ) : memorySectionOpen && spaceMemories.map(m => (
                  <div key={m.id} className="flex items-start gap-1.5 group py-1">
                    <input
                      type="checkbox"
                      checked={pinnedMemoryIds.includes(m.id)}
                      onChange={() => setPinnedMemoryIds(prev => prev.includes(m.id) ? prev.filter(id => id !== m.id) : [...prev, m.id])}
                      className="mt-0.5 shrink-0 accent-indigo-500 cursor-pointer"
                      title={t('memory.pinTitle')}
                    />
                    <button
                      onClick={() => handleMemoryAlwaysKeep(m.id, !m.alwaysKeep)}
                      className={`shrink-0 text-xs leading-none mt-0.5 transition-colors ${m.alwaysKeep ? 'text-amber-400 hover:text-amber-300' : 'text-gray-700 hover:text-gray-500 md:opacity-0 md:group-hover:opacity-100'}`}
                      title={m.alwaysKeep ? t('memory.alwaysKeptTitle') : t('memory.alwaysKeepTitle')}
                      aria-label={m.alwaysKeep ? t('memory.alwaysKeepUnset') : t('memory.alwaysKeep')}
                      aria-pressed={m.alwaysKeep}
                    >
                      {m.alwaysKeep ? '★' : '☆'}
                    </button>
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
                    <span className="text-[10px] text-gray-600 shrink-0 mt-0.5">{t(m.source === 'tool' ? 'memory.sourceAuto' : m.source === 'extraction' ? 'memory.sourceExtracted' : m.source === 'compact' ? 'memory.sourceCompact' : 'memory.sourceManual')}</span>
                    {editingMemoryId !== m.id && (
                      <button
                        onClick={() => { setMemoryDraft(m.content); setEditingMemoryId(m.id) }}
                        className="text-gray-700 hover:text-gray-400 text-xs shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                        aria-label={t('common.edit')}
                      >
                        ✎
                      </button>
                    )}
                    <RowAction
                      icon={<Trash2 size={14} />}
                      tone="danger"
                      label={t('common.delete')}
                      onClick={() => handleDeleteMemory(m.id)}
                    />
                  </div>
                ))}
              </div>

              </>}

              {/* Tagged files section */}
              <div className="border border-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setFilesSectionOpen(o => !o)}
                    className="flex items-center gap-1.5 text-sm font-medium text-gray-400 hover:text-gray-200"
                  >
                    <span>{filesSectionOpen ? '▾' : '▸'}</span>
                    Tagged resources ({taggedFiles.length})
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
                      + Tag resource
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
                  <p className="text-xs text-gray-600 mt-2">{t('files.noneUntagged')}</p>
                )}
                {filesSectionOpen && taggedFiles.length === 0 && !filePickerOpen && (
                  <p className="text-xs text-gray-600 mt-2">{t('files.noneTagged')}</p>
                )}
                {filesSectionOpen && taggedFiles.map(f => (
                  <div key={f.id} className="flex items-center gap-1.5 justify-between group py-1">
                    <input
                      type="checkbox"
                      checked={pinnedFileIds.includes(f.id)}
                      onChange={() => setPinnedFileIds(prev => prev.includes(f.id) ? prev.filter(id => id !== f.id) : [...prev, f.id])}
                      className="shrink-0 accent-indigo-500 cursor-pointer"
                      title={t('files.pinTitle')}
                    />
                    <span className="text-xs text-gray-300 truncate flex-1 min-w-0">{f.filename}</span>
                    <RowAction
                      icon={<X size={14} />}
                      tone="danger"
                      label={t('resource.untagFrom', { name: f.filename })}
                      onClick={async () => {
                        await untagFileFromSpace(currentSpaceId!, f.id)
                        setPinnedFileIds(prev => prev.filter(id => id !== f.id))
                        setTaggedFiles(prev => prev.filter(t => t.id !== f.id))
                      }}
                    />
                  </div>
                ))}
                {filesSectionOpen && taggedFiles.length > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={handleTransform}
                      disabled={transformStatus === 'loading'}
                      className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                      title={pinnedFileIds.length ? t('files.summarizeSelectedTitle') : t('files.summarizeAllTitle')}
                    >
                      {transformStatus === 'loading' ? t('files.summarizing') : `⟳ ${t('files.summarize')}`}
                    </button>
                    {transformStatus === 'error' && <span className="text-xs text-red-400">{transformError}</span>}
                  </div>
                )}
              </div>

              {!activeSpaceIsCollection && chatIndexStatus !== null && (
                <div className="border border-gray-800 rounded-lg p-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-500">
                    {t('space.chatIndex', { indexed: chatIndexStatus.indexed, total: chatIndexStatus.total })}
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
                      ? (rebuildIndexProgress ? t('space.indexing', { progress: rebuildIndexProgress }) : t('common.starting'))
                      : t('space.rebuildIndex')}
                  </button>
                </div>
              )}

              {!activeSpaceIsCollection && (() => {
                const loaded = spaceChats ?? []
                const filtered = loaded.filter(s => !sessionSearch || s.title.toLowerCase().includes(sessionSearch.toLowerCase()))
                return (
                  <>
                    <input
                      type="search"
                      placeholder={t('chat.searchPlaceholder')}
                      value={sessionSearch}
                      onChange={e => setSessionSearch(e.target.value)}
                      className="px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
                    />
                    {spaceChats === null ? (
                      <EmptyState>{t('chat.loading')}</EmptyState>
                    ) : filtered.length === 0 ? (
                      <EmptyState>{t(loaded.length === 0 ? 'chat.noneInSpace' : 'chat.noneMatching')}</EmptyState>
                    ) : filtered.map(s => (
                      <ChatRow
                        key={s.id}
                        chat={s}
                        spaceName={spaces.find(sp => sp.id === s.spaceId)?.name ?? null}
                        chatSpaces={chatSpaces}
                        spaceIsLocked={spaceIsLocked}
                        pickerOpen={spacePickerOpen === s.id}
                        onOpen={() => loadSession(s.id, s.title)}
                        onTogglePicker={() => setSpacePickerOpen(prev => prev === s.id ? null : s.id)}
                        onAssign={spaceId => handleAssignToSpace(s.id, spaceId)}
                        onRecreateMemories={() => { recreateChatMemories(s.id).catch(() => {}); setSpacePickerOpen(null) }}
                      />
                    ))}
                  </>
                )
              })()}
            </div>
          ) : (
            <SpacesView
              spaces={spaces}
              onOpen={setCurrentSpaceId}
              onCreate={handleCreateSpace}
              onToggleLock={handleToggleSpaceLock}
              onDelete={handleDeleteSpace}
            />
          )
        ) : view === 'files' ? (
          <ResourcesView resources={files} onChanged={reloadFiles} openId={openResourceId} onOpenIdChange={setOpenResourceId} />
        ) : view === 'monitors' ? (
          <MonitorsView
            spaces={spaces}
            isAdmin={currentUser?.role === 'admin'}
            timezone={currentUser?.settings?.timezone ?? ''}
            onCountChange={setMonitorCount}
            onOpenSession={(id, title) => { loadSession(id, title, false, true); setSidebarOpen(false) }}
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
                                title={t('space.goTo', { name: spaceName })}
                              >
                                {spaceName} ↗
                              </button>
                            )}
                            <button
                              onClick={() => setSpacePickerOpen(prev => prev === pickerId ? null : pickerId)}
                              className="text-xs px-1.5 py-0.5 rounded text-gray-600 hover:text-gray-400"
                              title={t('space.assignTo')}
                            >
                              ⊡
                            </button>
                            {spacePickerOpen === pickerId && (
                              <div className="absolute right-0 top-full mt-1 z-10 bg-gray-800 border border-gray-700 rounded shadow-lg min-w-36 py-1">
                                {chatSpaces.map(sp => {
                                  const blocked = spaceIsLocked(session?.spaceId) && !sp.offline
                                  return (
                                    <button
                                      key={sp.id}
                                      disabled={blocked}
                                      onClick={() => { handleAssignToSpace(sessionId, sp.id); setSpacePickerOpen(null) }}
                                      title={blocked ? t('space.moveBlocked') : undefined}
                                      className={`w-full text-left px-3 py-1.5 text-xs ${blocked ? 'text-gray-600 cursor-not-allowed' : 'hover:bg-gray-700'} ${session?.spaceId === sp.id ? 'text-indigo-400' : blocked ? '' : 'text-gray-300'}`}
                                    >
                                      {sp.offline && <Lock size={10} className="inline mr-1 -mt-0.5" />}
                                      {sp.name}
                                    </button>
                                  )
                                })}
                                {session?.spaceId && !spaceIsLocked(session?.spaceId) && (
                                  <button
                                    onClick={() => { handleAssignToSpace(sessionId, null); setSpacePickerOpen(null) }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-700 hover:text-red-400 border-t border-gray-700 mt-1 pt-1"
                                  >
                                    {t('space.removeFrom')}
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
                        aria-label={t('chat.editTitle')}
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => { setChatSearchOpen(o => !o); if (!chatSearchOpen) setTimeout(() => chatSearchInputRef.current?.focus(), 0) }}
                        className={`text-xs shrink-0 ${chatSearchOpen ? 'text-blue-400' : 'text-gray-600 hover:text-gray-400'}`}
                        aria-label={t('chat.searchIn')}
                        title={t('chat.searchInTitle')}
                      >
                        🔍
                      </button>
                    </>
                  )}
                </div>
              )
            })()}
            {chatSearchOpen && messages.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-900">
                <button
                  onClick={() => { const prev = (chatSearchCursor - 1 + chatMatchIndices.length) % Math.max(chatMatchIndices.length, 1); setChatSearchCursor(prev) }}
                  disabled={chatMatchIndices.length === 0}
                  className="text-gray-500 hover:text-gray-300 disabled:opacity-30 text-xs px-1"
                  title={t('chat.prevMatch')}
                >▲</button>
                <button
                  onClick={() => { setChatSearchCursor((chatSearchCursor + 1) % Math.max(chatMatchIndices.length, 1)) }}
                  disabled={chatMatchIndices.length === 0}
                  className="text-gray-500 hover:text-gray-300 disabled:opacity-30 text-xs px-1"
                  title={t('chat.nextMatch')}
                >▼</button>
                <input
                  ref={chatSearchInputRef}
                  value={chatSearchQuery}
                  onChange={e => setChatSearchQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      if (e.shiftKey) setChatSearchCursor(c => (c - 1 + Math.max(chatMatchIndices.length, 1)) % Math.max(chatMatchIndices.length, 1))
                      else setChatSearchCursor(c => (c + 1) % Math.max(chatMatchIndices.length, 1))
                    } else if (e.key === 'Escape') { setChatSearchOpen(false); setChatSearchQuery('') }
                  }}
                  placeholder={t('chat.searchInPlaceholder')}
                  className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-600 focus:outline-none min-w-0"
                />
                <span className="text-xs text-gray-600 shrink-0 tabular-nums">
                  {chatMatchIndices.length === 0
                    ? (chatSearchQuery.trim() ? t('chat.noMatches') : '')
                    : t('chat.matchPosition', { index: chatSearchCursor + 1, total: chatMatchIndices.length })}
                </span>
                <button
                  onClick={() => { setChatSearchOpen(false); setChatSearchQuery('') }}
                  className="text-gray-600 hover:text-gray-400 px-1"
                  title={t('chat.closeSearch')}
                ><X size={14} /></button>
              </div>
            )}
            {/* Persistent while the chat is in a locked space. The whole value of the mode is
                knowing it is on, so this stays visible for the entire conversation rather than
                appearing only where the lock was set. */}
            {activeSpaceLocked && (
              <div className="mx-4 mt-3 flex items-start gap-2 rounded border border-amber-700/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  <strong>{t('space.lockedBannerTitle')}</strong> {t('space.lockedBannerBody')}
                </span>
              </div>
            )}
            {spaceError && (
              <div className="mx-4 mt-3 flex items-start gap-2 rounded border border-red-700/50 bg-red-950/20 px-3 py-2 text-xs text-red-200">
                <span className="flex-1">{spaceError}</span>
                <button onClick={() => setSpaceError(null)} className="text-red-300 hover:text-red-100" aria-label={t('common.dismiss')}><X size={14} /></button>
              </div>
            )}
            {messages.length === 0 && !streaming ? (
              <div className="flex flex-col items-center justify-center flex-1 gap-3 text-gray-500 px-4">
                <img src="/logo.webp" alt="Queriocity" className="w-24 sm:w-32 md:w-40 h-auto" />
                <span className="text-2xl font-semibold text-gray-300">Queriocity</span>
                <span className="text-sm">{t('app.tagline')}</span>
                {/* The screen a new account lands on was otherwise blank. Clicking an example
                    sends it, exactly as a follow-up chip does — seeing one real answer explains
                    more than any amount of text about what the app is. */}
                <span className="text-xs text-gray-600 mt-2">{t('guide.tryOne')}</span>
                <div className="flex flex-col items-stretch gap-1.5 w-full max-w-sm">
                  {EXAMPLE_KEYS.map(key => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => submit(t(key))}
                      className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-xs text-left text-gray-400 hover:border-gray-700 hover:text-gray-200"
                    >
                      {t(key)}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => openGuide()}
                  className="text-xs text-blue-400 hover:underline"
                >
                  {t('guide.newHere')} →
                </button>
              </div>
            ) : (
              <ImageCaptionContext.Provider value={currentUser?.settings?.imageWatermark !== false}>
                <MessageList
                  messages={messages}
                  streaming={streaming}
                  streamingThinking={streamingThinking}
                  collapseFirstQuestion={isMonitorSession}
                  searchQuery={chatSearchOpen ? chatSearchQuery : ''}
                  searchActiveIndex={chatSearchOpen && chatMatchIndices.length > 0 ? chatMatchIndices[chatSearchCursor] : -1}
                  searchMatchIndices={chatSearchOpen ? chatMatchIndices : []}
                  onOpenResource={openResource}
                />
              </ImageCaptionContext.Provider>
            )}
            <ProgressLog steps={steps} collapsed={!busy || !!streaming} />
            {approval && (
              <div className="px-4">
                <ApprovalPrompt approval={approval} onDecide={decideApproval} />
              </div>
            )}
            {status && (
              <div className="px-4 py-1 text-xs text-gray-500 italic animate-pulse">
                {status}
                {busy && runStartedAt !== null && <> · <Elapsed from={runStartedAt} /></>}
              </div>
            )}
            {answerTime && !busy && (
              <div className="px-4 py-1 text-xs text-gray-500 flex items-center gap-3">
                <span>{answerTime}</span>
                {messages.some(m => m.role === 'assistant') && (
                  <button
                    onClick={regenerate}
                    title={t('chat.retryTitle')}
                    className="flex items-center gap-1 text-gray-500 hover:text-gray-300"
                  >
                    <RotateCcw size={11} /> {t('chat.retry')}
                  </button>
                )}
              </div>
            )}
            {sessionId && messages.length > 0 && !busy && (
              <div className="px-4 py-1 relative flex items-center">
                <div className="relative">
                  <button
                    onClick={() => setExportOpen(o => !o)}
                    onBlur={e => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) setExportOpen(false) }}
                    className="text-xs text-gray-600 hover:text-gray-400 flex items-center gap-0.5"
                  >
                    {t('export.menu')} ▾
                  </button>
                  {exportOpen && (
                    <div className="absolute bottom-full mb-1 left-0 bg-gray-800 border border-gray-700 rounded shadow-lg z-10 py-1 min-w-max">
                      <button onMouseDown={() => handleExport('full')} className="block w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-gray-700">
                        {t('export.fullChat')}
                      </button>
                      <button onMouseDown={() => handleExport('last')} className="block w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-gray-700">
                        {t('export.lastAnswer')}
                      </button>
                      <button onMouseDown={handlePrint} className="block w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-gray-700 border-t border-gray-700">
                        {t('export.print')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
            {focusMode === 'thorough' && currentUser?.settings?.useThinking && (
              <div className="px-4 py-0.5 text-xs text-purple-400 opacity-70">⬡ {t('chat.thinkingActive')}</div>
            )}
            <ChatInput
              key={sessionId ?? 'new'}
              onSubmit={submit}
              onCancel={cancel}
              disabled={busy}
              focusMode={focusMode}
              onFocusModeChange={setFocusMode}
              searchCategories={searchCategories}
              onSearchCategoriesChange={setSearchCategories}
              collections={spaces.filter(sp => sp.kind === 'collection')}
              selectedCollections={selectedCollections}
              onCollectionsChange={setSelectedCollections}
              suggestionsEnabled={currentUser?.settings?.querySuggestions !== false}
              lockedSpace={activeSpaceLocked}
              related={related}
              onRelatedSelect={q => { setRelated([]); submit(q) }}
            />
          </>
        )}
      </div>
    </div>
    </>
  )
}
