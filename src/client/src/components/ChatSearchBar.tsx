import { X } from 'lucide-react'
import type { ChatSearch } from '../hooks/useChatSearch.ts'
import { useT } from '../lib/i18n.tsx'

/** The find-in-chat bar under the chat header. */
export function ChatSearchBar({ search }: { search: ChatSearch }) {
  const t = useT()
  const { query, setQuery, cursor, matches, inputRef, close, next, prev } = search
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-900">
      <button
        onClick={prev}
        disabled={matches.length === 0}
        className="text-gray-500 hover:text-gray-300 disabled:opacity-30 text-xs px-1"
        title={t('chat.prevMatch')}
      >▲</button>
      <button
        onClick={next}
        disabled={matches.length === 0}
        className="text-gray-500 hover:text-gray-300 disabled:opacity-30 text-xs px-1"
        title={t('chat.nextMatch')}
      >▼</button>
      <input
        ref={inputRef}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) prev()
            else next()
          } else if (e.key === 'Escape') close()
        }}
        placeholder={t('chat.searchInPlaceholder')}
        className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-600 focus:outline-none min-w-0"
      />
      <span className="text-xs text-gray-600 shrink-0 tabular-nums">
        {matches.length === 0
          ? (query.trim() ? t('chat.noMatches') : '')
          : t('chat.matchPosition', { index: cursor + 1, total: matches.length })}
      </span>
      <button
        onClick={close}
        className="text-gray-600 hover:text-gray-400 px-1"
        title={t('chat.closeSearch')}
      ><X size={14} /></button>
    </div>
  )
}
