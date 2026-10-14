import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { setMessagePinned, deleteMessages, type Message } from '../lib/api.ts'
import type { ContextReport } from '@shared/context.ts'
import type { TFunction } from '../lib/i18n.tsx'

interface Deps {
  messages: Message[]
  setMessages: Dispatch<SetStateAction<Message[]>>
  setContext: (report: ContextReport | null) => void
  setStatus: (text: string) => void
  busy: boolean
  sessionId: string | undefined
  liveSessionRef: MutableRefObject<string | undefined>
  t: TFunction
}

/** Pinning and deleting stored messages, applied locally first and rolled back if the server refuses. */
export function useMessageActions({ messages, setMessages, setContext, setStatus, busy, sessionId, liveSessionRef, t }: Deps) {
  /** Pins are stored per message; one not yet stored (an ephemeral chat) is pinned for this tab only. */
  async function togglePin(index: number) {
    const msg = messages[index]
    if (!msg) return
    const pinned = !msg.pinned
    const apply = (value: boolean) => setMessages(prev => prev.map((m, i) => (i === index ? { ...m, pinned: value } : m)))
    apply(pinned)
    const sid = liveSessionRef.current ?? sessionId
    if (msg.id && sid) await setMessagePinned(sid, msg.id, pinned).catch(() => apply(!pinned))
  }

  /** Removes a question and its answer. Messages not yet stored (an ephemeral chat) go locally only.
   *  The context report is dropped: its indices point into the old list until the next turn. */
  async function deleteTurn(index: number) {
    if (busy || messages[index]?.role !== 'user') return
    const count = messages[index + 1]?.role === 'assistant' ? 2 : 1
    const removed = messages.slice(index, index + count)
    const before = messages
    setMessages(prev => [...prev.slice(0, index), ...prev.slice(index + count)])
    setContext(null)
    const ids = removed.map(m => m.id).filter((id): id is string => !!id)
    const sid = liveSessionRef.current ?? sessionId
    if (!ids.length || !sid) return
    try {
      await deleteMessages(sid, ids)
    } catch (err) {
      setMessages(before)
      setStatus(err instanceof Error ? err.message : t('answer.requestFailed'))
    }
  }

  return { togglePin, deleteTurn }
}
