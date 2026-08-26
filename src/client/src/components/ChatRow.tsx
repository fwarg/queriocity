import { Lock, Trash2 } from 'lucide-react'
import { ListRow, RowAction } from './ui.tsx'
import type { Space } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

export interface ChatSummary {
  id: string
  title: string
  spaceId: string | null
}

/** One chat in a list, with the picker that moves it between spaces.
 *
 *  Two copies of this lived in App.tsx — the Chats view and a space's own panel — and had already
 *  drifted apart in three ways. The differences that are real are props: the space panel offers to
 *  rebuild a chat's memories and has no delete, the Chats view has delete and shows the picker only
 *  when a space exists to move to. */
export function ChatRow({
  chat, spaceName, chatSpaces, spaceIsLocked, pickerOpen,
  onOpen, onTogglePicker, onAssign, onDelete, onRecreateMemories,
}: {
  chat: ChatSummary
  /** Null when the chat is in no space; the picker then labels itself with a placeholder. */
  spaceName: string | null
  /** Assignable destinations — spaces only, never collections. Empty hides the picker. */
  chatSpaces: Space[]
  spaceIsLocked: (spaceId: string | null) => boolean
  pickerOpen: boolean
  onOpen: () => void
  onTogglePicker: () => void
  onAssign: (spaceId: string | null) => void
  onDelete?: () => void
  onRecreateMemories?: () => void
}) {
  const t = useT()
  const locked = spaceIsLocked(chat.spaceId)

  return (
    <ListRow align="center" onClick={onOpen}>
      {locked && <Lock size={12} className="shrink-0 text-amber-400" aria-label={t('space.inLocked')} />}
      <span className="flex-1 min-w-0 truncate text-sm text-gray-100">{chat.title}</span>

      {chatSpaces.length > 0 && (
        <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            onClick={onTogglePicker}
            className={`px-2 py-1 rounded text-xs transition-opacity ${
              spaceName ? 'text-indigo-400 bg-indigo-900/40' : 'text-gray-600 hover:text-gray-400 md:opacity-0 md:group-hover:opacity-100'
            }`}
            title={t('space.moveTo')}
          >
            {spaceName ?? '⊡'}
          </button>
          {pickerOpen && (
            <div className="absolute right-0 top-full mt-1 z-10 bg-gray-800 border border-gray-700 rounded shadow-lg min-w-36 py-1">
              {/* A chat in a locked space may only move to another locked space, and "remove from
                  space" is the most permissive destination of all. Shown disabled rather than
                  hidden, so the restriction is legible. */}
              {chatSpaces.map(sp => {
                const blocked = locked && !sp.offline
                return (
                  <button
                    key={sp.id}
                    type="button"
                    disabled={blocked}
                    onClick={() => onAssign(sp.id)}
                    title={blocked ? t('space.moveBlocked') : undefined}
                    className={`w-full text-left px-3 py-1.5 text-xs ${blocked ? 'text-gray-600 cursor-not-allowed' : 'hover:bg-gray-700'} ${chat.spaceId === sp.id ? 'text-indigo-400' : blocked ? '' : 'text-gray-300'}`}
                  >
                    {sp.offline && <Lock size={10} className="inline mr-1 -mt-0.5" />}
                    {sp.name}
                  </button>
                )
              })}
              {onRecreateMemories && (
                <button
                  type="button"
                  onClick={onRecreateMemories}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-200 border-t border-gray-700 mt-1 pt-1"
                >
                  {t('memory.recreateForChat')}
                </button>
              )}
              {chat.spaceId && !locked && (
                <button
                  type="button"
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

      {onDelete && (
        <RowAction
          icon={<Trash2 size={14} />}
          tone="danger"
          label={t('chat.deleteNamed', { title: chat.title })}
          onClick={onDelete}
        />
      )}
    </ListRow>
  )
}
