import { BookOpen, Trash2 } from 'lucide-react'
import { RowAction } from './ui.tsx'
import type { ChatHistory } from '../hooks/useChatHistory.ts'
import { useT } from '../lib/i18n.tsx'

/** The views the sidebar switches to; clicking the open one goes back to the chat. */
export type NavView = 'chats' | 'files' | 'spaces' | 'explore'

interface Props {
  /** Shown as an overlay on narrow screens; always shown from `md` up. */
  open: boolean
  onClose: () => void
  view: NavView | 'chat'
  onNavigate: (view: NavView) => void
  counts: { chats: number; resources: number; spaces: number; tags: number }
  history: ChatHistory
  /** Narrows the loaded chats by title, client-side. */
  filter: string
  onFilterChange: (filter: string) => void
  /** The chat open in the chat view, highlighted in the list. */
  activeChatId: string | undefined
  onNewChat: () => void
  onOpenChat: (id: string, title: string) => void
  onDeleteChat: (id: string) => void
  onGuide: () => void
  onSettings: () => void
  /** Absent for anyone but an admin. */
  onAdmin?: () => void
  onSignOut: () => void
  userLabel: string
}

/** Navigation, the recent chats, and the account actions. */
export function Sidebar({
  open, onClose, view, onNavigate, counts, history, filter, onFilterChange, activeChatId,
  onNewChat, onOpenChat, onDeleteChat, onGuide, onSettings, onAdmin, onSignOut, userLabel,
}: Props) {
  const t = useT()
  return (
    <>
    {open && (
      <div
        className="fixed inset-0 bg-black/50 z-20 md:hidden"
        onClick={onClose}
      />
    )}
    <aside className={`
      fixed inset-y-0 left-0 z-30 w-64 bg-gray-900 border-r border-gray-800 flex flex-col p-3 gap-1
      transform transition-transform duration-200
      ${open ? 'translate-x-0' : '-translate-x-full'}
      md:relative md:translate-x-0 md:w-56 md:z-auto md:transition-none
    `}>
      <div className="px-3 py-2">
        <div className="text-base font-bold text-gray-50 tracking-wide">Queriocity</div>
        <div className="text-xs text-gray-500">v{__APP_VERSION__}</div>
      </div>
      <button
        onClick={() => { onNewChat(); onClose() }}
        className="w-full text-left px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium"
      >
        + {t('chat.new')}
      </button>
      <button
        onClick={() => { onNavigate('chats'); onClose() }}
        className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'chats' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
      >
        {t('nav.chats')} ({counts.chats})
      </button>
      <button
        onClick={() => { onNavigate('files'); onClose() }}
        className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'files' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
      >
        {t('nav.resources')} ({counts.resources})
      </button>
      <button
        onClick={() => { onNavigate('spaces'); onClose() }}
        className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'spaces' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
      >
        {t('nav.workspaces')} ({counts.spaces})
      </button>
      <button
        onClick={() => { onNavigate('explore'); onClose() }}
        className={`w-full text-left px-3 py-2 rounded text-sm font-medium ${view === 'explore' ? 'bg-indigo-700 text-white' : 'text-indigo-400 hover:bg-gray-800'}`}
      >
        {t('nav.explore')} ({counts.tags})
      </button>
      <div className="border-t border-gray-800 my-1" />
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
        {history.sessions.length > 5 && (
          <input
            type="search"
            placeholder={t('chat.searchPlaceholder')}
            value={filter}
            onChange={e => onFilterChange(e.target.value)}
            className="mx-1 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
          />
        )}
        {history.sessions.filter(s => !filter || s.title.toLowerCase().includes(filter.toLowerCase())).map(s => (
          <div key={s.id} className={`flex items-center rounded hover:bg-gray-800 ${activeChatId === s.id ? 'bg-gray-800' : ''}`}>
            <button onClick={() => { onOpenChat(s.id, s.title); onClose() }} className="flex-1 text-left px-3 py-2 text-sm truncate">
              {s.title}
            </button>
            <RowAction
              icon={<Trash2 size={14} />}
              tone="danger"
              persistent
              label={t('chat.deleteNamed', { title: s.title })}
              onClick={() => onDeleteChat(s.id)}
            />
          </div>
        ))}
        <div ref={history.sidebarSentinelRef} className="py-1 text-center text-xs text-gray-600">
          {history.loadingMore ? t('common.loading') : ''}
        </div>
      </div>

      {/* Bottom user area */}
      <div className="border-t border-gray-800 pt-2 flex flex-col gap-1">
        <button onClick={() => { onGuide(); onClose() }} className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800 flex items-center gap-1.5">
          <BookOpen size={12} /> {t('nav.guide')}
        </button>
        <button onClick={() => { onSettings(); onClose() }} className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800">
          ⚙ {t('nav.settings')}
        </button>
        {onAdmin && (
          <button onClick={() => { onAdmin(); onClose() }} className="w-full text-left px-3 py-2 rounded text-xs text-gray-400 hover:bg-gray-800">
            ◈ {t('nav.admin')}
          </button>
        )}
        <button onClick={onSignOut} className="w-full text-left px-3 py-2 rounded text-xs text-gray-500 hover:bg-gray-800 hover:text-red-400">
          {t('nav.signOut')} — {userLabel}
        </button>
      </div>
    </aside>
    </>
  )
}
