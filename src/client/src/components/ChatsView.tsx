import type { Dispatch, SetStateAction } from 'react'
import { ViewTabs } from './ViewTabs.tsx'
import { MonitorsView } from './MonitorsView.tsx'
import { SectionHeader } from './SectionHeader.tsx'
import { ChatRow } from './ChatRow.tsx'
import { EmptyState } from './ui.tsx'
import type { ChatHistory } from '../hooks/useChatHistory.ts'
import type { Space } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

export type ChatsTab = 'chats' | 'monitors'

interface Props {
  tab: ChatsTab
  onTabChange: (tab: ChatsTab) => void
  history: ChatHistory
  chatCount: number
  monitorCount: number
  onMonitorCountChange: (count: number) => void
  spaces: Space[]
  /** Spaces a chat can be moved to. */
  chatSpaces: Space[]
  spaceName: (id: string | null) => string | null
  spaceIsLocked: (id: string | null | undefined) => boolean
  isAdmin: boolean
  timezone: string
  spacePickerOpen: string | null
  onSpacePickerChange: Dispatch<SetStateAction<string | null>>
  onOpenChat: (id: string, title: string) => void
  /** A monitor's run, opened as a chat with its prompt collapsed. */
  onOpenMonitorRun: (id: string, title: string) => void
  onAssignChat: (chatId: string, spaceId: string | null) => void
  onDeleteChat: (id: string) => void
}

/** The Chats view: every chat, sortable and searchable, with Monitors as a second tab — a monitor is
 *  a recurring chat, and its runs are chats. */
export function ChatsView({
  tab, onTabChange, history, chatCount, monitorCount, onMonitorCountChange, spaces, chatSpaces, spaceName,
  spaceIsLocked, isAdmin, timezone, spacePickerOpen, onSpacePickerChange, onOpenChat, onOpenMonitorRun, onAssignChat, onDeleteChat,
}: Props) {
  const t = useT()
  return (
    <div className="flex flex-col flex-1 min-h-0">
    <ViewTabs
      tabs={[
        { id: 'chats' as const, label: `${t('nav.chats')} (${chatCount})` },
        { id: 'monitors' as const, label: `${t('nav.monitors')} (${monitorCount})` },
      ]}
      active={tab}
      onChange={onTabChange}
    />
    {tab === 'monitors' ? (
      <MonitorsView
        spaces={spaces}
        isAdmin={isAdmin}
        timezone={timezone}
        onCountChange={onMonitorCountChange}
        onOpenSession={onOpenMonitorRun}
      />
    ) : (
    <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-3" onClick={() => onSpacePickerChange(null)}>
      <div className="mb-2">
      <SectionHeader title={t('nav.chats')} intro={t('chat.intro')} about={t('chat.aboutTitle')} topic="gettingStarted">
        {!history.results && (
          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => history.setSort('updated')} className={history.sort === 'updated' ? 'text-indigo-400' : 'text-gray-500 hover:text-gray-300'}>{t('chat.sortActive')}</button>
            <span className="text-gray-700">·</span>
            <button onClick={() => history.setSort('created')} className={history.sort === 'created' ? 'text-indigo-400' : 'text-gray-500 hover:text-gray-300'}>{t('chat.sortCreated')}</button>
          </div>
        )}
      </SectionHeader>
      </div>
      <input
        type="search"
        placeholder={t('chat.searchAllPlaceholder')}
        value={history.search}
        onChange={e => history.setSearch(e.target.value)}
        className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none focus:border-indigo-500 mb-1"
      />
      {history.results !== null && (
        <p className="text-xs text-gray-500 mb-1">
          {history.results.length === 0 ? t('common.noResults') : t('common.results', { count: history.results.length })}
        </p>
      )}
      {(history.results ?? history.sessions).length === 0 && !history.search ? (
        <EmptyState>{t('chat.noneSaved')}</EmptyState>
      ) : (history.results ?? history.sessions).map(s => (
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
          onDelete={() => onDeleteChat(s.id)}
        />
      ))}
      {!history.results && (
        <div ref={history.sentinelRef} className="py-1 text-center text-xs text-gray-600">
          {history.loadingMore ? t('common.loading') : ''}
        </div>
      )}
    </div>
    )}
    </div>
  )
}
