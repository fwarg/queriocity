import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '../lib/api.ts'

/** Find-in-chat: the open bar, its query, which messages match and which one is current.
 *
 *  Closes on switching chats, and opens on Ctrl/Cmd+F while `shortcutEnabled`. */
export function useChatSearch({ messages, sessionId, shortcutEnabled }: {
  messages: Message[]
  sessionId: string | undefined
  shortcutEnabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const matches = useMemo(() => {
    if (!open || !query.trim()) return []
    const q = query.toLowerCase()
    return messages.reduce<number[]>((acc, msg, i) => {
      if (msg.content.toLowerCase().includes(q)) acc.push(i)
      return acc
    }, [])
  }, [messages, query, open])

  useEffect(() => { setCursor(0) }, [query, sessionId])
  useEffect(() => { setOpen(false); setQuery('') }, [sessionId])

  const focusInput = () => setTimeout(() => inputRef.current?.focus(), 0)

  useEffect(() => {
    if (!shortcutEnabled) return
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setOpen(true)
        focusInput()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcutEnabled])

  const step = (by: 1 | -1) => setCursor(c => (c + by + Math.max(matches.length, 1)) % Math.max(matches.length, 1))

  return {
    open, query, setQuery, cursor, matches, inputRef,
    /** Index into `messages` of the current match, or -1. */
    activeIndex: open && matches.length > 0 ? matches[cursor] : -1,
    toggle: () => { setOpen(o => !o); if (!open) focusInput() },
    close: () => { setOpen(false); setQuery('') },
    next: () => step(1),
    prev: () => step(-1),
  }
}

export type ChatSearch = ReturnType<typeof useChatSearch>
