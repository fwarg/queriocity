import { useState } from 'react'
import { Lock } from 'lucide-react'
import type { Space } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

interface Props {
  title: string
  /** The space the chat is in, and its name when the space list has it. */
  spaceId: string | null
  spaceName: string | null
  /** Offer the picker at all: there is somewhere a chat could go. */
  canAssign: boolean
  /** Spaces a chat can be moved to. */
  chatSpaces: Space[]
  /** The chat's space is locked: it may only move to another locked space, and cannot leave. */
  locked: boolean
  pickerOpen: boolean
  onTogglePicker: () => void
  onGoToSpace: (spaceId: string) => void
  onAssign: (spaceId: string | null) => void
  onRename: (title: string) => void
  searchOpen: boolean
  onToggleSearch: () => void
}

/** The open chat's title bar: rename, the space it is in, and find-in-chat. App keys it by chat,
 *  so an unfinished rename does not carry over to the next one. */
export function ChatHeader({
  title, spaceId, spaceName, canAssign, chatSpaces, locked, pickerOpen, onTogglePicker, onGoToSpace, onAssign, onRename,
  searchOpen, onToggleSearch,
}: Props) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function save() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed) onRename(trimmed)
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 min-h-[2.5rem]">
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        />
      ) : (
        <>
          <span className="flex-1 text-sm text-gray-400 truncate">{title}</span>
          {canAssign && (
            <div className="relative shrink-0 flex items-center gap-1">
              {spaceId && spaceName && (
                <button
                  onClick={() => onGoToSpace(spaceId)}
                  className="text-xs px-2 py-0.5 rounded text-indigo-400 bg-indigo-900/40 hover:bg-indigo-800/60"
                  title={t('space.goTo', { name: spaceName })}
                >
                  {spaceName} ↗
                </button>
              )}
              <button
                onClick={onTogglePicker}
                className="text-xs px-1.5 py-0.5 rounded text-gray-600 hover:text-gray-400"
                title={t('space.assignTo')}
              >
                ⊡
              </button>
              {pickerOpen && (
                <div className="absolute right-0 top-full mt-1 z-10 bg-gray-800 border border-gray-700 rounded shadow-lg min-w-36 py-1">
                  {chatSpaces.map(sp => {
                    const blocked = locked && !sp.offline
                    return (
                      <button
                        key={sp.id}
                        disabled={blocked}
                        onClick={() => onAssign(sp.id)}
                        title={blocked ? t('space.moveBlocked') : undefined}
                        className={`w-full text-left px-3 py-1.5 text-xs ${blocked ? 'text-gray-600 cursor-not-allowed' : 'hover:bg-gray-700'} ${spaceId === sp.id ? 'text-indigo-400' : blocked ? '' : 'text-gray-300'}`}
                      >
                        {sp.offline && <Lock size={10} className="inline mr-1 -mt-0.5" />}
                        {sp.name}
                      </button>
                    )
                  })}
                  {spaceId && !locked && (
                    <button
                      onClick={() => onAssign(null)}
                      className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-700 hover:text-red-400 border-t border-gray-700 mt-1 pt-1"
                    >
                      {t('space.removeFrom')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => { setDraft(title); setEditing(true) }}
            className="text-xs text-gray-600 hover:text-gray-400 shrink-0"
            aria-label={t('chat.editTitle')}
          >
            ✎
          </button>
          <button
            onClick={onToggleSearch}
            className={`text-xs shrink-0 ${searchOpen ? 'text-blue-400' : 'text-gray-600 hover:text-gray-400'}`}
            aria-label={t('chat.searchIn')}
            title={t('chat.searchInTitle')}
          >
            🔍
          </button>
        </>
      )}
    </div>
  )
}
