import { useEffect, useRef, useState } from 'react'
import { fetchHistory, searchHistory } from '../lib/api.ts'

/** A chat in the history lists. `locked`: its space is locked; `chatLocked`: the chat itself is,
 *  having read the confidential collections and resources named in `lockedBy`. */
export type Session = { id: string; title: string; spaceId: string | null; locked?: boolean; chatLocked?: boolean | number; lockedBy?: string[] }

export type ChatSort = 'updated' | 'created'

const PAGE_SIZE = 50

/** The user's chats, a page at a time, plus the server-side search over all of them.
 *
 *  One list feeds both the sidebar and the Chats view; each renders a sentinel (pass `sentinelRef` or
 *  `sidebarSentinelRef` as its `ref`), and whichever scrolls into view loads the next page. Reloaded
 *  from the top when the sort changes or another user signs in. */
export function useChatHistory({ userId, onError }: { userId: string | undefined; onError: (err: unknown) => void }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [total, setTotal] = useState(0)
  const [sort, setSort] = useState<ChatSort>('updated')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Session[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const offsetRef = useRef(0)
  // State rather than refs: the Chats view's sentinel only exists while that view is open, and the
  // observer has to be rebuilt when it appears — a ref changing would not rerun the effect below.
  const [sentinel, sentinelRef] = useState<HTMLDivElement | null>(null)
  const [sidebarSentinel, sidebarSentinelRef] = useState<HTMLDivElement | null>(null)

  function loadPage(offset: number, replace: boolean) {
    setLoadingMore(true)
    fetchHistory(sort, offset)
      .then(({ items, total }) => {
        setSessions(prev => replace ? items : [...prev, ...items])
        setTotal(total)
        offsetRef.current = offset + items.length
        setHasMore(items.length === PAGE_SIZE)
      })
      .catch(onError)
      .finally(() => setLoadingMore(false))
  }

  useEffect(() => {
    if (!userId) return
    offsetRef.current = 0
    setSessions([])
    setHasMore(false)
    loadPage(0, true)
  }, [sort, userId])

  useEffect(() => {
    if (!search.trim()) { setResults(null); return }
    const timer = setTimeout(() => {
      searchHistory(search.trim()).then(setResults).catch(onError)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    const obs = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && !loadingMore && hasMore) loadPage(offsetRef.current, false)
    })
    if (sentinel) obs.observe(sentinel)
    if (sidebarSentinel) obs.observe(sidebarSentinel)
    return () => obs.disconnect()
  }, [hasMore, loadingMore, sort, sentinel, sidebarSentinel])

  return { sessions, setSessions, total, sort, setSort, search, setSearch, results, loadingMore, sentinelRef, sidebarSentinelRef }
}

export type ChatHistory = ReturnType<typeof useChatHistory>
