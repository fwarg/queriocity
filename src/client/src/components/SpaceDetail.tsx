import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { Trash2, X } from 'lucide-react'
import { ChatRow, type ChatSummary } from './ChatRow.tsx'
import { EmptyState, PRIMARY_BTN, RowAction } from './ui.tsx'
import { TagResourcePicker } from './TagResourcePicker.tsx'
import { byTypeThenTitle, ResourceTypeIcon } from './ResourceFilters.tsx'
import { useConfirm } from './confirm.tsx'
import {
  fetchFiles, recreateChatMemories,
  fetchSpaceMemories, createSpaceMemory, updateSpaceMemory, deleteSpaceMemory, compactSpaceMemories, recreateAllSpaceMemories, clearSpaceMemories,
  fetchChatIndexStatus, rebuildChatIndex, fetchSpaceFiles, tagFileToSpace, untagFileFromSpace, transformSpace,
} from '../lib/api.ts'
import type { Resource, Space, SpaceFile, SpaceMemory } from '../lib/api.ts'
import { errorMessage } from '../lib/errors.ts'
import { useLang, useT } from '../lib/i18n.tsx'

const MEMORY_HEADER_TOKENS = 30

/** Per-memory content cap, mirrored from the server's zod `.max(600)` on the add/edit routes. */
const MEMORY_CONTENT_MAXLEN = 600

/** Bare hostname for a source chip; falls back to the raw string. */
function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

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

interface Props {
  space: Space
  /** Spaces a chat can be moved to. */
  chatSpaces: Space[]
  spaceName: (id: string | null) => string | null
  spaceIsLocked: (id: string | null | undefined) => boolean
  memoryTokenBudget: number
  /** The space's chats, fetched by App; `null` while loading. */
  chats: ChatSummary[] | null
  sessionSearch: string
  onSessionSearchChange: (q: string) => void
  spacePickerOpen: string | null
  onSpacePickerChange: Dispatch<SetStateAction<string | null>>
  /** Pins narrow the space's next chat turn, so they live with the chat state in App. */
  pinnedFileIds: string[]
  setPinnedFileIds: Dispatch<SetStateAction<string[]>>
  pinnedMemoryIds: string[]
  setPinnedMemoryIds: Dispatch<SetStateAction<string[]>>
  onBack: () => void
  onRename: (name: string) => void
  /** Resource and chat counts on the space list follow tagging. */
  onSpacesChanged: () => void
  onError: (message: string) => void
  onAnalyze: () => void
  onCreateRecipe: () => void
  onCompileNotes: () => void
  onPromote: () => void
  onNewChat: () => void
  onOpenChat: (id: string, title: string) => void
  onAssignChat: (chatId: string, spaceId: string | null) => void
  onOpenResource: (id: string) => void
}

/** One space or collection opened from the Spaces view: its memory, tagged resources, chat index and chats.
 *
 *  App keys it by the space and its kind, so opening another space, or promoting a collection, mounts
 *  a fresh one — every section closed, every list fetched for that space. */
export function SpaceDetail({
  space, chatSpaces, spaceName, spaceIsLocked, memoryTokenBudget, chats, sessionSearch, onSessionSearchChange,
  spacePickerOpen, onSpacePickerChange, pinnedFileIds, setPinnedFileIds, pinnedMemoryIds, setPinnedMemoryIds,
  onBack, onRename, onSpacesChanged, onError, onAnalyze, onCreateRecipe, onCompileNotes, onPromote, onNewChat,
  onOpenChat, onAssignChat, onOpenResource,
}: Props) {
  const t = useT()
  const { lang } = useLang()
  const confirm = useConfirm()
  // Memory, the chat index and the chat list describe conversations, which a collection has none of.
  const isCollection = space.kind === 'collection'
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [spaceMemories, setSpaceMemories] = useState<SpaceMemory[]>([])
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [newMemoryOpen, setNewMemoryOpen] = useState(false)
  const [newMemoryDraft, setNewMemoryDraft] = useState('')
  const [memorySectionOpen, setMemorySectionOpen] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [compactResult, setCompactResult] = useState<string | null>(null)
  const [recreating, setRecreating] = useState(false)
  const [recreateProgress, setRecreateProgress] = useState<string | null>(null)
  const [taggedFiles, setTaggedFiles] = useState<SpaceFile[]>([])
  const [filesSectionOpen, setFilesSectionOpen] = useState(false)
  const [allUserFiles, setAllUserFiles] = useState<Resource[]>([])
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [transformStatus, setTransformStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [transformError, setTransformError] = useState('')
  const [chatIndexStatus, setChatIndexStatus] = useState<{ indexed: number; total: number } | null>(null)
  const [rebuildingIndex, setRebuildingIndex] = useState(false)
  const [rebuildIndexProgress, setRebuildIndexProgress] = useState<string | null>(null)

  const reloadMemories = () => { fetchSpaceMemories(space.id).then(({ memories }) => setSpaceMemories(memories)).catch(() => {}) }

  useEffect(() => {
    fetchSpaceFiles(space.id).then(setTaggedFiles).catch(() => {})
    if (isCollection) return
    fetchSpaceMemories(space.id).then(({ memories }) => setSpaceMemories(memories)).catch(() => {})
    fetchChatIndexStatus(space.id).then(setChatIndexStatus).catch(() => {})
  }, [space.id, isCollection])

  function saveName() {
    const name = nameDraft.trim()
    setEditingName(false)
    if (name) onRename(name)
  }

  /** Reports a failed memory change and reloads the list, undoing any optimistic edit. */
  function memoryFailed(err: unknown) {
    onError(errorMessage(t, err, t('memory.saveFailed')))
    reloadMemories()
  }

  function handleCreateMemory() {
    const content = newMemoryDraft.trim()
    if (!content) { setNewMemoryOpen(false); return }
    createSpaceMemory(space.id, content).then(m => {
      setSpaceMemories(prev => [m, ...prev])
      setNewMemoryDraft('')
      setNewMemoryOpen(false)
    }).catch(memoryFailed)
  }

  function handleDeleteMemory(id: string) {
    deleteSpaceMemory(space.id, id).then(() => {
      setSpaceMemories(prev => prev.filter(m => m.id !== id))
    }).catch(memoryFailed)
  }

  function handleMemorySave(id: string) {
    const content = memoryDraft.trim()
    setEditingMemoryId(null)
    if (!content) return
    setSpaceMemories(prev => prev.map(m => m.id === id ? { ...m, content } : m))
    updateSpaceMemory(space.id, id, { content }).catch(memoryFailed)
  }

  function handleMemoryAlwaysKeep(id: string, alwaysKeep: boolean) {
    setSpaceMemories(prev => prev.map(m => m.id === id ? { ...m, alwaysKeep } : m))
    updateSpaceMemory(space.id, id, { alwaysKeep }).catch(memoryFailed)
  }

  async function handleTransform() {
    setTransformStatus('loading')
    setTransformError('')
    try {
      const fileIds = pinnedFileIds.length ? pinnedFileIds : undefined
      await transformSpace(space.id, 'summarize', fileIds)
      reloadMemories()
      setTransformStatus('idle')
    } catch (err: unknown) {
      setTransformStatus('error')
      setTransformError(err instanceof Error ? err.message : t('space.transformFailed'))
      setTimeout(() => setTransformStatus('idle'), 5000)
    }
  }

  return (
      <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-3">
        <div className="flex items-center flex-wrap gap-3 mb-2">
          <button
            onClick={onBack}
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            ← {t('nav.workspaces')}
          </button>
          {editingName ? (
            <input
              autoFocus
              type="text"
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false) }}
              onBlur={() => saveName()}
              className="text-lg font-semibold bg-transparent border-b border-indigo-500 text-gray-100 focus:outline-none"
            />
          ) : (
            <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">
              {space.name}
              <button
                onClick={() => { setNameDraft(space.name); setEditingName(true) }}
                className="text-gray-600 hover:text-gray-400 text-sm"
                aria-label={t('space.rename')}
              >
                ✎
              </button>
            </h2>
          )}
          {isCollection ? (
            <div className="ml-auto flex flex-wrap gap-2">
              <button
                onClick={onAnalyze}
                title={t('collection.analyzeTitle')}
                className={PRIMARY_BTN}
              >
                {t('collection.analyze')}
              </button>
              <button
                onClick={onCreateRecipe}
                title={t('collection.recipeTitle')}
                className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                {t('collection.recipe')}
              </button>
              <button
                onClick={onCompileNotes}
                title={t('collection.compileTitle')}
                className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                {t('collection.compile')}
              </button>
              <button
                onClick={onPromote}
                title={t('collection.promoteTitle')}
                className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                {t('collection.promote')}
              </button>
            </div>
          ) : (
            <div className="ml-auto flex flex-wrap gap-2">
              {space.resourceCount > 0 && (
                <button
                  onClick={onAnalyze}
                  title={t('space.analyzeTitle')}
                  className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
                >
                  {t('collection.analyze')}
                </button>
              )}
              {space.resourceCount > 0 && (
                <button
                  onClick={onCompileNotes}
                  title={t('collection.compileTitle')}
                  className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
                >
                  {t('collection.compile')}
                </button>
              )}
              <button
                onClick={onNewChat}
                className={PRIMARY_BTN}
              >
                + {t('chat.new')}
              </button>
            </div>
          )}
        </div>
        {/* Memory describes conversations, which a collection has none of — as do the chat
            index and the chat list further down, each guarded the same way because the
            resources section sits between them. Resources are the whole of a collection. */}
        {!isCollection && <>
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
                        const { before, after, compacted } = await compactSpaceMemories(space.id)
                        if (compacted) reloadMemories()
                        setCompactResult(compacted ? `${before} → ${after}` : t('memory.alreadyCompact'))
                        setTimeout(() => setCompactResult(null), 4000)
                      } catch (err) {
                        memoryFailed(err)
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
                      for await (const ev of recreateAllSpaceMemories(space.id)) {
                        if (ev.processing !== undefined) setRecreateProgress(`${ev.processing}/${ev.total}`)
                        if (ev.done) {
                          reloadMemories()
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
                    await clearSpaceMemories(space.id).then(() => setSpaceMemories([]), memoryFailed)
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
            const overflow = countOverflowMemories(spaceMemories, memoryTokenBudget)
            return overflow > 0 ? (
              <p className="text-xs text-gray-500 mt-1">
                {t('memory.overflow', { count: overflow })}
              </p>
            ) : null
          })()}
          {memorySectionOpen && newMemoryOpen && (
            <div className="mb-2">
              <textarea
                autoFocus
                rows={2}
                maxLength={MEMORY_CONTENT_MAXLEN}
                value={newMemoryDraft}
                onChange={e => setNewMemoryDraft(e.target.value)}
                onInput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreateMemory(); if (e.key === 'Escape') { setNewMemoryOpen(false); setNewMemoryDraft('') } }}
                onBlur={handleCreateMemory}
                placeholder={t('memory.addPlaceholder')}
                className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500 resize-none"
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
                <textarea
                  autoFocus
                  rows={2}
                  maxLength={MEMORY_CONTENT_MAXLEN}
                  value={memoryDraft}
                  onChange={e => setMemoryDraft(e.target.value)}
                  onInput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleMemorySave(m.id); if (e.key === 'Escape') setEditingMemoryId(null) }}
                  onBlur={() => handleMemorySave(m.id)}
                  className="flex-1 px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500 resize-none"
                />
              ) : (
                <div className="flex-1 min-w-0">
                  <span
                    onClick={() => { setMemoryDraft(m.content); setEditingMemoryId(m.id) }}
                    className="block text-xs text-gray-300 cursor-pointer hover:text-gray-100 whitespace-pre-wrap break-words"
                  >
                    {m.content}
                  </span>
                  {((m.sources && m.sources.length > 0) || m.checkedAt != null) && (
                    <div className="flex flex-wrap items-center gap-1 mt-0.5" title={m.sources && m.sources.length > 0 ? t('memory.sourcesTitle') : undefined}>
                      {m.sources?.map(s => (
                        <a
                          key={s.url}
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={s.title}
                          className="max-w-[11rem] truncate rounded bg-gray-800 px-1 py-0.5 text-[10px] text-gray-400 hover:text-gray-200"
                        >
                          {hostnameOf(s.url)}
                        </a>
                      ))}
                      {m.checkedAt != null && (
                        <span
                          className="text-[10px] text-gray-600"
                          title={t('memory.checkedTitle', { date: new Date(m.checkedAt * 1000).toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric' }) })}
                        >
                          {t('memory.checked', { date: new Date(m.checkedAt * 1000).toLocaleDateString(lang, { month: 'short', day: 'numeric' }) })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
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
                  try {
                    const all = await fetchFiles()
                    setAllUserFiles(all.filter(f => !taggedFiles.some(t => t.id === f.id)))
                    setFilePickerOpen(o => !o)
                  } catch (err) {
                    onError(errorMessage(t, err, t('space.resourcesFailed')))
                  }
                }}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                + {t('files.tagResource')}
              </button>
            )}
          </div>
          {filesSectionOpen && filePickerOpen && allUserFiles.length > 0 && (
            <TagResourcePicker
              resources={allUserFiles}
              onTag={async id => {
                try { await tagFileToSpace(space.id, id) } catch (err) {
                  onError(errorMessage(t, err, t('space.resourcesFailed')))
                  return
                }
                setAllUserFiles(prev => prev.filter(f => f.id !== id))
                fetchSpaceFiles(space.id).then(setTaggedFiles).catch(() => {})
                onSpacesChanged()
              }}
            />
          )}
          {filesSectionOpen && filePickerOpen && allUserFiles.length === 0 && (
            <p className="text-xs text-gray-600 mt-2">{t('files.noneUntagged')}</p>
          )}
          {filesSectionOpen && taggedFiles.length === 0 && !filePickerOpen && (
            <p className="text-xs text-gray-600 mt-2">{t('files.noneTagged')}</p>
          )}
          {filesSectionOpen && [...taggedFiles].sort(byTypeThenTitle).map(f => (
            <div key={f.id} className="flex items-center gap-1.5 justify-between group py-1">
              {/* Pins narrow a space's chats to these resources; a collection has no chats. */}
              {!isCollection && (
                <input
                  type="checkbox"
                  checked={pinnedFileIds.includes(f.id)}
                  onChange={() => setPinnedFileIds(prev => prev.includes(f.id) ? prev.filter(id => id !== f.id) : [...prev, f.id])}
                  className="shrink-0 accent-indigo-500 cursor-pointer"
                  title={t('files.pinTitle')}
                />
              )}
              <ResourceTypeIcon resource={f} size={12} />
              <button
                onClick={() => onOpenResource(f.id)}
                title={t('files.openResource')}
                className="text-left text-xs text-gray-300 hover:text-gray-50 hover:underline truncate flex-1 min-w-0"
              >
                {f.filename}
              </button>
              <RowAction
                icon={<X size={14} />}
                tone="danger"
                label={t('resource.untagFrom', { name: f.filename })}
                onClick={async () => {
                  try { await untagFileFromSpace(space.id, f.id) } catch (err) {
                    onError(errorMessage(t, err, t('space.resourcesFailed')))
                    return
                  }
                  onSpacesChanged()
                  setPinnedFileIds(prev => prev.filter(id => id !== f.id))
                  setTaggedFiles(prev => prev.filter(t => t.id !== f.id))
                }}
              />
            </div>
          ))}
          {/* The summary is saved as space memory, which only a space's chats read. */}
          {filesSectionOpen && taggedFiles.length > 0 && !isCollection && (
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

        {!isCollection && chatIndexStatus !== null && (
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
                  for await (const ev of rebuildChatIndex(space.id)) {
                    if (ev.processing !== undefined) setRebuildIndexProgress(`${ev.processing}/${ev.total}`)
                    if (ev.done) fetchChatIndexStatus(space.id).then(setChatIndexStatus).catch(() => {})
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

        {!isCollection && (() => {
          const loaded = chats ?? []
          const filtered = loaded.filter(s => !sessionSearch || s.title.toLowerCase().includes(sessionSearch.toLowerCase()))
          return (
            <>
              <input
                type="search"
                placeholder={t('chat.searchPlaceholder')}
                value={sessionSearch}
                onChange={e => onSessionSearchChange(e.target.value)}
                className="px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
              />
              {chats === null ? (
                <EmptyState>{t('chat.loading')}</EmptyState>
              ) : filtered.length === 0 ? (
                <EmptyState>{t(loaded.length === 0 ? 'chat.noneInSpace' : 'chat.noneMatching')}</EmptyState>
              ) : filtered.map(s => (
                <ChatRow
                  key={s.id}
                  chat={s}
                  spaceName={spaceName(s.spaceId)}
                  chatSpaces={chatSpaces}
                  spaceIsLocked={spaceIsLocked}
                  pickerOpen={spacePickerOpen === s.id}
                  onOpen={() => onOpenChat(s.id, s.title)}
                  onTogglePicker={() => onSpacePickerChange(prev => prev === s.id ? null : s.id)}
                  onAssign={spaceId => onAssignChat(s.id, spaceId)}
                  onRecreateMemories={() => { recreateChatMemories(s.id).catch(() => {}); onSpacePickerChange(null) }}
                />
              ))}
            </>
          )
        })()}
      </div>
  )
}
