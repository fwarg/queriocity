import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { RotateCcw, ShieldCheck } from 'lucide-react'
import { MessageList, ImageCaptionContext } from './components/MessageList.tsx'
import { PromptStudio } from './components/PromptStudio.tsx'
import { ContextMeter } from './components/ContextIndicators.tsx'
import { ProgressLog, Elapsed } from './components/ProgressLog.tsx'
import { ApprovalPrompt } from './components/ApprovalPrompt.tsx'
import { ChatInput } from './components/ChatInput.tsx'
import { LoginPage } from './components/LoginPage.tsx'
import { RegisterPage } from './components/RegisterPage.tsx'
import { SettingsPanel } from './components/SettingsPanel.tsx'
import { AdminPanel } from './components/AdminPanel.tsx'
import { ExploreView } from './components/ExploreView.tsx'
import type { ResourceFilter } from './components/ResourceFilters.tsx'
import { useConfirm } from './components/confirm.tsx'
import { useGuide, useGuideNavigation } from './components/GuideView.tsx'
import type { GuideTarget } from '@shared/guide/index.ts'
import { ErrorBanner } from './components/ui.tsx'
import { errorMessage } from './lib/errors.ts'
import { SpacesView } from './components/SpacesView.tsx'
import { SpaceDetail } from './components/SpaceDetail.tsx'
import { Sidebar, type NavView } from './components/Sidebar.tsx'
import { ChatsView, type ChatsTab } from './components/ChatsView.tsx'
import { ChatHeader } from './components/ChatHeader.tsx'
import { ChatSearchBar } from './components/ChatSearchBar.tsx'
import { ExportMenu } from './components/ExportMenu.tsx'
import { ResourcesView } from './components/ResourcesView.tsx'
import {
  fetchHistory, fetchSession, deleteSession, updateSessionTitle, fetchFiles, updateSettings, fetchSpaces,
  createSpace, promoteCollection, updateSpace, deleteSpace, assignChatToSpace, fetchMonitors, activeRecipe,
} from './lib/api.ts'
import type { Resource, Space, SpaceKind, CustomTemplate } from './lib/api.ts'
import { useChat } from './hooks/useChat.ts'
import { useModelPicker } from './hooks/useModelPicker.ts'
import { useChatSearch } from './hooks/useChatSearch.ts'
import { useChatHistory, type Session } from './hooks/useChatHistory.ts'
import { useAuth } from './hooks/useAuth.ts'
import { useUserPreferences } from './hooks/useUserPreferences.ts'
import { useT } from './lib/i18n.tsx'
import { DEFAULT_THEME } from '@shared/theme.ts'
import type { ContextReport } from '@shared/context.ts'
import type { CollectionMode } from '@shared/context.ts'

/** One per mode worth showing off: something current, something comparative, something explained. */
const EXAMPLE_KEYS = ['guide.example1', 'guide.example2', 'guide.example3'] as const

type MainView = 'chat' | NavView
const CHATS_TAB_KEY = 'queriocity.chatsTab'
const NOTES_FIRST_KEY = 'queriocity.notesFirst'

export default function App() {
  const t = useT()
  const confirm = useConfirm()
  const openGuide = useGuide()
  const { authView, setAuthView, currentUser, setCurrentUser, inviteToken, signedIn, signOut } = useAuth()
  useUserPreferences(currentUser)

  const [focusMode, setFocusMode] = useState<'flash' | 'balanced' | 'thorough' | 'image'>('balanced')
  const [searchCategories, setSearchCategories] = useState<Array<'news' | 'science' | 'discussions' | 'tech'>>([])
  // "Notes first" is a habit rather than a per-question choice, so it is remembered.
  const [notesFirst, setNotesFirstState] = useState(() => { try { return localStorage.getItem(NOTES_FIRST_KEY) === '1' } catch { return false } })
  const setNotesFirst = useCallback((on: boolean) => {
    setNotesFirstState(on)
    try { localStorage.setItem(NOTES_FIRST_KEY, on ? '1' : '0') } catch { /* not remembered in private mode */ }
  }, [])
  /** Collections picked for the next message — per request, never stored on the chat.
   *
   *  Held here rather than in ChatInput, which remounts per session, so a selection survives asking
   *  several questions in a row. It also survives switching chats, which is deliberate: the chips
   *  are visibly lit, so an unwanted one is obvious and one click away, whereas silently clearing a
   *  shelf the user had set up would be the more surprising of the two. */
  const [selectedCollections, setSelectedCollections] = useState<string[]>([])
  const [collectionMode, setCollectionMode] = useState<CollectionMode>('auto')
  const [exploreWeb, setExploreWeb] = useState(false)
  const [exploreNotes, setExploreNotes] = useState(false)
  // The recipe whose chip is in the input: it applies to every message of this chat until removed,
  // and a new or other chat starts without it.
  const [recipe, setRecipe] = useState<CustomTemplate | null>(null)
  // One resource read as Explore's document, e.g. to save notes from it; per chat, like the picks.
  const [scopedDocument, setScopedDocument] = useState<{ id: string; title: string } | null>(null)
  /** A note to instruct a new recipe: the template dialog is open with it. */
  const [recipeSeed, setRecipeSeed] = useState<{ id: string; title: string } | null>(null)
  // Text put into the message box from outside it (Compile into notes); `n` makes a repeat count.
  const [inputSeed, setInputSeed] = useState<{ text: string; n: number }>()

  const [sessionId, setSessionId] = useState<string | undefined>()
  const [sessionSearch, setSessionSearch] = useState('')
  const [files, setFiles] = useState<Resource[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  /** Message from a refused lock change or chat move — both are server decisions the user cannot
   *  predict from the UI alone, so the reason has to be surfaced rather than silently reverted. */
  const [spaceError, setSpaceError] = useState<string | null>(null)
  /** A list the user is looking at could not be fetched: said, rather than shown empty or stale. */
  const loadFailed = useCallback((err: unknown) => setSpaceError(errorMessage(t, err, t('common.loadFailed'))), [t])
  const history = useChatHistory({ userId: currentUser?.id, onError: loadFailed })
  const { sessions, setSessions } = history
  const [monitorCount, setMonitorCount] = useState(0)
  const [isMonitorSession, setIsMonitorSession] = useState(false)
  const [currentSpaceId, setCurrentSpaceId] = useState<string | null>(null)
  const [spacePickerOpen, setSpacePickerOpen] = useState<string | null>(null)
  const [pinnedFileIds, setPinnedFileIds] = useState<string[]>([])
  const [pinnedMemoryIds, setPinnedMemoryIds] = useState<string[]>([])
  /** Chats belonging to the open space, fetched server-side. `null` while loading. */
  const [spaceChats, setSpaceChats] = useState<Session[] | null>(null)
  const [view, setView] = useState<MainView>('chat')
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null)
  // Monitors live as a tab of Chats: a monitor is a recurring chat, and its runs are chats.
  const [chatsTab, setChatsTabState] = useState<ChatsTab>(() => {
    try { return localStorage.getItem(CHATS_TAB_KEY) === 'monitors' ? 'monitors' : 'chats' } catch { return 'chats' }
  })
  const setChatsTab = useCallback((tab: ChatsTab) => {
    setChatsTabState(tab)
    try { localStorage.setItem(CHATS_TAB_KEY, tab) } catch { /* private mode: the tab just isn't remembered */ }
  }, [])
  // Which resource's detail panel is open in the Resources view. Lives here rather than inside
  // ResourcesView so a chat citation's [F1]/[C1] reference can open one directly from outside it.
  const [openResourceId, setOpenResourceId] = useState<string | null>(null)
  // The filter the library opens with when Explore sends the user there (a tag, or "untagged").
  const [resourceSeed, setResourceSeed] = useState<Partial<ResourceFilter> | null>(null)
  const openResource = useCallback((id: string) => {
    setResourceSeed(null)
    setOpenResourceId(id)
    setView('files')
    setSidebarOpen(false)
  }, [])
  const [showSettings, setShowSettings] = useState(false)
  const [showAdmin, setShowAdmin] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // The guide's "Open Spaces →" buttons. Registered rather than passed, because the guide is
  // mounted above App so that any view's ⓘ can open it.
  useGuideNavigation(useCallback((target: GuideTarget) => {
    if (target === 'settings') { setShowSettings(true); return }
    if (target === 'spaces') setCurrentSpaceId(null)
    if (target === 'files') setOpenResourceId(null)
    if (target === 'monitors' || target === 'chats') setChatsTab(target)
    setView(target === 'monitors' ? 'chats' : target)
    setSidebarOpen(false)
  }, [setChatsTab]))

  const activeSpaceId = sessionId
    ? sessions.find(s => s.id === sessionId)?.spaceId ?? null
    : currentSpaceId

  // Advisory only — the server decides this from the database on every request. This drives the
  // banner and the disabled controls, so a stale value degrades the UI, never the guarantee.
  const activeSpaceLocked = !!activeSpaceId && spaces.some(s => s.id === activeSpaceId && s.offline)
  const spaceIsLocked = (id: string | null | undefined) => !!id && spaces.some(sp => sp.id === id && sp.offline)
  const currentSpace = spaces.find(sp => sp.id === currentSpaceId)
  const activeSpaceIsCollection = currentSpace?.kind === 'collection'
  // The chat's own lock, from having read a confidential collection or resource; and whether the next
  // message would lock it by picking a confidential collection. Advisory, as above.
  const activeSession = sessionId ? [...sessions, ...(spaceChats ?? [])].find(s => s.id === sessionId) : undefined
  const activeChatLocked = !!activeSession?.chatLocked
  const pickedLockedCollection = spaces.some(sp => sp.kind === 'collection' && sp.offline && selectedCollections.includes(sp.id))
  const turnLocked = activeSpaceLocked || activeChatLocked || pickedLockedCollection
  /** Only spaces can hold a chat, so only spaces are offered as a destination for one. The server
   *  refuses a collection either way; this keeps the UI from proposing what it will refuse. */
  const chatSpaces = spaces.filter(sp => sp.kind === 'space')

  /** The id the server just gave a new chat, so receiving it is not taken for opening another chat. */
  const createdSessionRef = useRef<string | undefined>(undefined)
  const modelPicker = useModelPicker({
    focusMode,
    locked: turnLocked,
    enabled: !!currentUser,
    useThinking: currentUser?.settings?.useThinking === true,
    cloudAcknowledged: currentUser?.settings?.cloudAcknowledged === true,
    onAcknowledge: async () => {
      if (!currentUser) return
      const settings = { ...currentUser.settings, cloudAcknowledged: true }
      // Persisting is best-effort: a failed save only means the notice is shown again next session.
      await updateSettings(settings).catch(() => {})
      setCurrentUser({ ...currentUser, settings })
    },
  })

  const { messages, setMessages, context, setContext, togglePin, deleteTurn, streaming, streamingThinking, status, setStatus, answerTime, busy, submit, regenerate, cancel, reset, related, setRelated, steps, runStartedAt, approval, decideApproval } = useChat({
    sessionId,
    focusMode,
    modelId: modelPicker.picked || undefined,
    searchCategories,
    notesFirst,
    includeFileIds: pinnedFileIds.length ? pinnedFileIds : undefined,
    collectionIds: selectedCollections.length ? selectedCollections : undefined,
    collectionMode,
    // Only an Explore turn reads it; the server also drops it when the turn is locked.
    exploreWeb: collectionMode === 'explore' && exploreWeb,
    exploreNotes: collectionMode === 'explore' && exploreNotes,
    recipe: recipe ? activeRecipe(recipe) : undefined,
    documentIds: scopedDocument ? [scopedDocument.id] : undefined,
    includeMemoryIds: pinnedMemoryIds.length ? pinnedMemoryIds : undefined,
    spaceId: activeSpaceId ?? undefined,
    followUpSuggestions: currentUser?.settings?.followUpSuggestions !== false,
    onSessionCreated: (id, title, lockedBy) => {
      createdSessionRef.current = id
      setSessionId(id)
      const lock = lockedBy ? { chatLocked: true, lockedBy } : {}
      setSessions(prev => prev.some(s => s.id === id)
        ? (lockedBy ? prev.map(s => s.id === id ? { ...s, ...lock } : s) : prev)
        : [{ id, title, spaceId: activeSpaceId, ...lock }, ...prev])
      if (lockedBy) setSpaceChats(prev => prev && prev.map(s => s.id === id ? { ...s, ...lock } : s))
      if (activeSpaceId) {
        setSpaces(sps => sps.map(sp => sp.id === activeSpaceId ? { ...sp, chatCount: sp.chatCount + 1 } : sp))
        if (activeSpaceId === currentSpaceId) {
          setSpaceChats(prev => prev && prev.some(s => s.id === id) ? prev : [{ id, title, spaceId: activeSpaceId }, ...(prev ?? [])])
        }
      }
    },
    onSessionTitle: (id, title) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s))
      setSpaceChats(prev => prev && prev.map(s => s.id === id ? { ...s, title } : s))
    },
  })

  /** While idle the meter is sized for the next message's model, which a pick or a mode switch
   *  changes; during a run it shows the run's own report. */
  const meterReport = (report: ContextReport): ContextReport =>
    busy || modelPicker.meterBudget === undefined ? report : { ...report, budgetChars: modelPicker.meterBudget }

  // A pick lasts for the chat it was made in: opening another chat, or starting a new one, goes back
  // to the default. A new chat receiving its id after the first message is not a switch.
  const { reset: resetModelPick } = modelPicker
  useEffect(() => {
    // Matched once only: reopening that chat later from the sidebar is a switch like any other.
    if (sessionId && sessionId === createdSessionRef.current) { createdSessionRef.current = undefined; return }
    resetModelPick()
  }, [sessionId, resetModelPick])

  // The pickable models carry what is left of each budget, which every answer spends.
  const { refresh: refreshModels } = modelPicker
  useEffect(() => { if (!busy) refreshModels() }, [busy, refreshModels])

  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPinnedFileIds([])
    setPinnedMemoryIds([])
    // Fetched per space rather than filtered out of `sessions`: that array holds only the most recent
    // page, so a space with no recently-updated chats would look empty. A collection holds no chats;
    // `activeSpaceIsCollection` is a dependency so promotion fills the list in without reopening.
    setSpaceChats(null)
    if (!currentSpaceId || activeSpaceIsCollection) return
    fetchHistory(history.sort, 0, currentSpaceId)
      .then(({ items }) => setSpaceChats(items))
      .catch(err => { setSpaceChats([]); setSpaceError(errorMessage(t, err, t('space.loadFailed'))) })
  }, [currentSpaceId, activeSpaceIsCollection])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    // `steps` included: the progress log grows below the last message, so without it the log
    // is pushed off the bottom of a long conversation exactly when it is worth reading.
  }, [messages, streaming, steps])

  const findInChat = useChatSearch({ messages, sessionId, shortcutEnabled: view === 'chat' && messages.length > 0 })

  async function handleLogout() {
    await signOut()
    setSessions([])
    setFiles([])
    setSpaces([])
    setMessages([])
    setCurrentSpaceId(null)
    setMonitorCount(0)
  }


  /** Picked collections and how they are read belong to the chat they were picked in, like the model
   *  pick: carried into another chat, a confidential one would lock it without asking. */
  function clearCollectionPicks() {
    setSelectedCollections([])
    setCollectionMode('auto')
    setExploreWeb(false)
    setExploreNotes(false)
    setRecipe(null)
    setScopedDocument(null)
  }

  function loadSession(id: string, title: string, addToHistory = true, fromMonitor = false) {
    setFocusMessageId(null)
    clearCollectionPicks()
    setSessionId(id)
    setIsMonitorSession(fromMonitor)
    reset()
    setView('chat')
    fetchSession(id)
      .then(s => { setMessages(s.messages); setContext(s.context) })
      .catch(err => setSpaceError(errorMessage(t, err, t('chat.loadFailed'))))
    if (addToHistory) {
      setSessions(prev => {
        const existing = prev.find(s => s.id === id)
        return [{ id, title, spaceId: existing?.spaceId ?? null }, ...prev.filter(s => s.id !== id)]
      })
    }
  }

  /** Opens a chat at a given answer — "Saved from chat" on a note. */
  function openChatAt(id: string, title: string, messageId?: string) {
    loadSession(id, title)
    setFocusMessageId(messageId ?? null)
  }

  function newChat(inSpaceId?: string) {
    clearCollectionPicks()
    setSessionId(undefined)
    setIsMonitorSession(false)
    reset()
    setCurrentSpaceId(inSpaceId ?? null)
    setView('chat')
  }

  /** A new chat that reads every document in the collection; its answer can be saved as a note there.
   *  A confidential collection locks that chat, so it is asked first. */
  async function analyzeCollection(collectionId: string): Promise<boolean> {
    const collection = spaces.find(sp => sp.id === collectionId)
    if (collection?.offline && !await confirm({ message: t('chat.lockConfirmNew', { name: collection.name }), confirmLabel: t('chat.lockConfirmAction') })) return false
    newChat()
    setSelectedCollections([collectionId])
    setCollectionMode('whole')
    return true
  }

  /** A new chat in the space that reads every resource tagged to it; the space's lock covers it. */
  function analyzeSpace(spaceId: string) {
    newChat(spaceId)
    setCollectionMode('whole')
  }

  /** A new chat set up to explore the collection (or the space's resources) and save its main ideas
   *  as notes; the prompt is put in the message box for the user to check and send. */
  async function compileIntoNotes(id: string, isCollection: boolean) {
    if (isCollection) {
      const collection = spaces.find(sp => sp.id === id)
      if (collection?.offline && !await confirm({ message: t('chat.lockConfirmNew', { name: collection.name }), confirmLabel: t('chat.lockConfirmAction') })) return
      newChat()
      setSelectedCollections([id])
    } else newChat(id)
    setCollectionMode('explore')
    setExploreNotes(true)
    // Web off to start: the notes come from the documents; the user turns it on for a niche collection.
    setExploreWeb(false)
    setInputSeed({ text: t('collection.compilePrompt'), n: Date.now() })
  }

  /** A new chat that reads every document and describes their style; its answer, saved with the
   *  recipe action, becomes a new recipe's instructions. */
  async function createRecipeFromCollection(collectionId: string) {
    if (!await analyzeCollection(collectionId)) return
    setInputSeed({ text: t('collection.stylePrompt'), n: Date.now() })
  }

  /** A new chat that explores one document and saves notes from it; a confidential one locks the
   *  chat, so it is asked first. */
  async function saveNotesFromDocument(resource: { id: string; filename: string; confidential: boolean }) {
    if (resource.confidential && !await confirm({ message: t('chat.lockConfirmNew', { name: resource.filename }), confirmLabel: t('chat.lockConfirmAction') })) return
    newChat()
    setScopedDocument({ id: resource.id, title: resource.filename })
    setCollectionMode('explore')
    setExploreNotes(true)
    setInputSeed({ text: t('collection.compileDocumentPrompt'), n: Date.now() })
  }

  function handleRenameChat(title: string) {
    if (!sessionId) return
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s))
    setSpaceChats(prev => prev?.map(s => s.id === sessionId ? { ...s, title } : s) ?? prev)
    updateSessionTitle(sessionId, title).catch(err => setStatus(errorMessage(t, err, t('chat.renameFailed'))))
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

  /** A sidebar view: opened, or closed back to the chat when it is already open. Resources and Spaces
   *  open on their list, not on whatever resource or space was last looked at. */
  function toggleView(target: NavView) {
    setView(v => v === target ? 'chat' : target)
    if (target === 'files') { setOpenResourceId(null); setResourceSeed(null) }
    if (target === 'spaces') setCurrentSpaceId(null)
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
    }).catch(err => setSpaceError(errorMessage(t, err, t('space.deleteFailed'))))
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
    if (next && sp.kind === 'collection') {
      if (!await confirm({ message: t('collection.confidentialConfirm', { name: sp.name }), confirmLabel: t('collection.markConfidential') })) return
    } else if (next) {
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

  function handleSpaceRename(id: string, name: string) {
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

  /** ResourcesView mutates the library; the list stays here because the space panel tags from it. */
  // Spaces too: their resource counts follow tagging, adding and deleting, and decide whether a space
  // chat offers to read its resources.
  const reloadFiles = useCallback(() => {
    fetchFiles().then(setFiles).catch(loadFailed)
    fetchSpaces().then(setSpaces).catch(loadFailed)
  }, [loadFailed])
  // Refreshed whenever a view that lists the library opens: notes are also created from chat
  // answers, splits and the server side, none of which pass through these views.
  // The user's library, spaces and monitor count: on sign-in, and on a session restored at load.
  useEffect(() => {
    if (!currentUser) return
    reloadFiles()
    fetchMonitors().then(ms => setMonitorCount(ms.length)).catch(loadFailed)
  }, [currentUser?.id])
  useEffect(() => { if (view === 'files' || view === 'explore') reloadFiles() }, [view, reloadFiles])
  const tagCount = useMemo(() => new Set(files.flatMap(f => f.tags)).size, [files])

  // Auth screens
  if (authView === 'loading' && !currentUser) {
    return <div className="flex h-screen items-center justify-center text-gray-500 text-sm">{t('common.loading')}</div>
  }
  if (authView === 'login') {
    return (
      <LoginPage
        onLogin={signedIn}
        showRegisterLink={!!inviteToken}
        onRegister={() => setAuthView('register')}
      />
    )
  }
  if (authView === 'register') {
    return (
      <RegisterPage
        onRegister={signedIn}
        inviteToken={inviteToken}
        showLoginLink={true}
        onLogin={() => setAuthView('login')}
      />
    )
  }

  return (
    <>
    {recipeSeed && (
      <PromptStudio
        seed={{ name: recipeSeed.title, instructions: [recipeSeed] }}
        onSave={() => setRecipeSeed(null)}
        onClose={() => setRecipeSeed(null)}
      />
    )}
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
          theme={currentUser.settings?.theme ?? DEFAULT_THEME}
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
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        view={view}
        onNavigate={toggleView}
        counts={{ chats: history.total || sessions.length, resources: files.length, spaces: spaces.length, tags: tagCount }}
        history={history}
        filter={sessionSearch}
        onFilterChange={setSessionSearch}
        activeChatId={view === 'chat' ? sessionId : undefined}
        onNewChat={() => newChat()}
        onOpenChat={(id, title) => loadSession(id, title)}
        onDeleteChat={id => handleDeleteSession(id)}
        onGuide={() => openGuide()}
        onSettings={() => setShowSettings(true)}
        onAdmin={currentUser?.role === 'admin' ? () => setShowAdmin(true) : undefined}
        onSignOut={handleLogout}
        userLabel={currentUser?.name ?? currentUser?.email ?? ''}
      />

      {/* Main */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        {/* Mobile header bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-400 hover:text-gray-50 text-xl leading-none"
            aria-label={t('nav.openMenu')}
          >
            ☰
          </button>
          <span className="font-semibold text-gray-50 text-sm">Queriocity</span>
        </div>
        {/* Every view: the chat moves, lock changes and space edits that fail are made from several. */}
        <ErrorBanner message={spaceError} onDismiss={() => setSpaceError(null)} className="mx-4 mt-3" />
        {view === 'chats' ? (
          <ChatsView
            tab={chatsTab}
            onTabChange={setChatsTab}
            history={history}
            chatCount={history.total || sessions.length}
            monitorCount={monitorCount}
            onMonitorCountChange={setMonitorCount}
            spaces={spaces}
            chatSpaces={chatSpaces}
            spaceName={id => id ? spaces.find(sp => sp.id === id)?.name ?? null : null}
            spaceIsLocked={spaceIsLocked}
            isAdmin={currentUser?.role === 'admin'}
            timezone={currentUser?.settings?.timezone ?? ''}
            spacePickerOpen={spacePickerOpen}
            onSpacePickerChange={setSpacePickerOpen}
            onOpenChat={(id, title) => loadSession(id, title)}
            onOpenMonitorRun={(id, title) => { loadSession(id, title, false, true); setSidebarOpen(false) }}
            onAssignChat={handleAssignToSpace}
            onDeleteChat={id => handleDeleteSession(id)}
          />
        ) : view === 'spaces' ? (
          currentSpace ? (
            <SpaceDetail
              key={`${currentSpace.id}:${currentSpace.kind}`}
              space={currentSpace}
              chatSpaces={chatSpaces}
              spaceName={id => spaces.find(sp => sp.id === id)?.name ?? null}
              spaceIsLocked={spaceIsLocked}
              memoryTokenBudget={currentUser?.memoryTokenBudget ?? 1500}
              chats={spaceChats}
              sessionSearch={sessionSearch}
              onSessionSearchChange={setSessionSearch}
              spacePickerOpen={spacePickerOpen}
              onSpacePickerChange={setSpacePickerOpen}
              pinnedFileIds={pinnedFileIds}
              setPinnedFileIds={setPinnedFileIds}
              pinnedMemoryIds={pinnedMemoryIds}
              setPinnedMemoryIds={setPinnedMemoryIds}
              onBack={() => setCurrentSpaceId(null)}
              onRename={name => handleSpaceRename(currentSpace.id, name)}
              onSpacesChanged={() => { fetchSpaces().then(setSpaces).catch(() => {}) }}
              onError={setSpaceError}
              onAnalyze={() => currentSpace.kind === 'collection' ? analyzeCollection(currentSpace.id) : analyzeSpace(currentSpace.id)}
              onCreateRecipe={() => createRecipeFromCollection(currentSpace.id)}
              onCompileNotes={() => compileIntoNotes(currentSpace.id, currentSpace.kind === 'collection')}
              onPromote={handlePromoteCollection}
              onNewChat={() => newChat(currentSpace.id)}
              onOpenChat={(id, title) => loadSession(id, title)}
              onAssignChat={handleAssignToSpace}
              onOpenResource={openResource}
            />
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
          <ResourcesView resources={files} onChanged={reloadFiles} openId={openResourceId} onOpenIdChange={setOpenResourceId} onOpenChat={openChatAt} onSaveNotes={saveNotesFromDocument} onNewRecipe={setRecipeSeed} initialFilter={resourceSeed ?? undefined} />
        ) : view === 'explore' ? (
          <ExploreView
            resources={files}
            spaces={spaces}
            onOpenTag={tag => { setResourceSeed({ tag }); setOpenResourceId(null); setView('files') }}
            onShow={show => { setResourceSeed({ show }); setOpenResourceId(null); setView('files') }}
            onOpenResource={openResource}
            onOpenChat={(id, title) => loadSession(id, title)}
            onTagsChanged={reloadFiles}
          />
        ) : (
          <>
            {sessionId && (() => {
              const spaceId = activeSession?.spaceId ?? null
              const pickerId = `heading-${sessionId}`
              return (
                <ChatHeader
                  // Prefixed: ChatInput, a sibling, is keyed by the bare session id, and two siblings
                  // with one key leave React unable to remove the old header.
                  key={`header-${sessionId}`}
                  title={sessions.find(s => s.id === sessionId)?.title ?? ''}
                  spaceId={spaceId}
                  spaceName={spaceId ? spaces.find(sp => sp.id === spaceId)?.name ?? null : null}
                  canAssign={spaces.length > 0}
                  chatSpaces={chatSpaces}
                  locked={spaceIsLocked(spaceId)}
                  pickerOpen={spacePickerOpen === pickerId}
                  onTogglePicker={() => setSpacePickerOpen(prev => prev === pickerId ? null : pickerId)}
                  onGoToSpace={id => { setCurrentSpaceId(id); setView('spaces') }}
                  onAssign={id => handleAssignToSpace(sessionId, id)}
                  onRename={handleRenameChat}
                  searchOpen={findInChat.open}
                  onToggleSearch={findInChat.toggle}
                />
              )
            })()}
            {findInChat.open && messages.length > 0 && <ChatSearchBar search={findInChat} />}
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
            {activeChatLocked && !activeSpaceLocked && (
              <div className="mx-4 mt-3 flex items-start gap-2 rounded border border-amber-700/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  <strong>{t('chat.lockedBannerTitle')}</strong>{' '}
                  {activeSession?.lockedBy?.length
                    ? t('chat.lockedBannerBodyNamed', { names: activeSession.lockedBy.join(', ') })
                    : t('chat.lockedBannerBody')}
                </span>
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
                  searchQuery={findInChat.open ? findInChat.query : ''}
                  searchActiveIndex={findInChat.activeIndex}
                  searchMatchIndices={findInChat.open ? findInChat.matches : []}
                  onOpenResource={openResource}
                  sessionId={sessionId}
                  context={context}
                  onTogglePin={togglePin}
                  onDeleteTurn={busy ? undefined : deleteTurn}
                  focusMessageId={focusMessageId}
                  onNotesChanged={reloadFiles}
                  styleNoteTitle={selectedCollections.length ? t('recipe.styleNoteTitle', { name: selectedCollections.map(id => spaces.find(sp => sp.id === id)?.name).filter(Boolean).join(', ') }) : undefined}
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
                <ExportMenu messages={messages} title={sessions.find(s => s.id === sessionId)?.title} />
                {context && <div className="ml-auto"><ContextMeter report={meterReport(context)} model={busy ? undefined : modelPicker.meterModel} /></div>}
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
              collectionMode={collectionMode}
              onCollectionModeChange={setCollectionMode}
              exploreWeb={exploreWeb}
              onExploreWebChange={setExploreWeb}
              exploreNotes={exploreNotes}
              onExploreNotesChange={setExploreNotes}
              seed={inputSeed}
              recipe={recipe}
              onRecipeChange={setRecipe}
              scopedDocument={scopedDocument}
              onScopedDocumentChange={setScopedDocument}
              spaceResources={spaces.find(sp => sp.id === activeSpaceId && sp.kind === 'space')?.resourceCount ?? 0}
              notesAvailable={files.some(f => f.kind === 'note')}
              notesFirst={notesFirst}
              onNotesFirstChange={setNotesFirst}
              suggestionsEnabled={currentUser?.settings?.querySuggestions !== false}
              lockedSpace={turnLocked}
              chatLocked={activeSpaceLocked || activeChatLocked}
              hasHistory={messages.length > 0}
              spaceId={activeSpaceId ?? undefined}
              onAddedToLibrary={reloadFiles}
              related={related}
              onRelatedSelect={q => { setRelated([]); submit(q) }}
              models={modelPicker.available}
              modelId={modelPicker.picked}
              defaultModel={modelPicker.defaultModel}
              onModelChange={modelPicker.choose}
            />
          </>
        )}
      </div>
    </div>
    </>
  )
}
