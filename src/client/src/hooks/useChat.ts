import { useState, useRef } from 'react'
import { streamChat, stopChat, fetchRelatedQuestions } from '../lib/api.ts'
import { hasAttachment, type ContextReport } from '@shared/context.ts'
import type { Message } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { ChatRun, type FocusMode } from './chat-run.ts'
import { useEgressApproval } from './useEgressApproval.ts'
import { useMessageActions } from './useMessageActions.ts'
import { useLiveAnswer } from './useLiveAnswer.ts'


interface UseChatOptions {
  sessionId: string | undefined
  focusMode: FocusMode
  searchCategories?: Array<'news' | 'science' | 'discussions' | 'tech'>
  /** Answer from the user's own notes before the web. */
  notesFirst?: boolean
  includeFileIds?: string[]
  collectionIds?: string[]
  /** Read every document in the collections rather than the excerpts nearest the question. */
  wholeCollection?: boolean
  includeMemoryIds?: string[]
  spaceId?: string
  /** User setting; when false no related-questions call is made at all. */
  followUpSuggestions?: boolean
  /** An extra model picked for this chat's messages. */
  modelId?: string
  onSessionCreated: (id: string, title: string, lockedBy?: string[]) => void
}

/** Gives the just-sent question its stored id, so it can be pinned without reloading the chat. */
function withStoredId(messages: Message[], id: string | undefined): Message[] {
  const last = messages[messages.length - 1]
  if (!id || !last || last.role !== 'user' || last.id) return messages
  return [...messages.slice(0, -1), { ...last, id }]
}

/** The conversation without its last answer, and the question to ask again; null when there is none. */
function retryOf(messages: Message[]): { history: Message[]; question: string } | null {
  const lastAnswer = messages.findLastIndex(m => m.role === 'assistant')
  if (lastAnswer === -1) return null
  const history = messages.slice(0, lastAnswer)
  const lastUser = [...history].reverse().find(m => m.role === 'user')
  return lastUser ? { history, question: lastUser.content } : null
}

export function useChat(options: UseChatOptions) {
  const { sessionId, focusMode, followUpSuggestions = true, modelId, onSessionCreated } = options
  const t = useT()
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const live = useLiveAnswer()
  const { setStreaming, setStreamingThinking, setStatus, setAnswerTime, setRelated, setSteps, clearLive } = live
  /** What the model saw of the conversation on the latest turn; null until a turn reports it. */
  const [context, setContext] = useState<ContextReport | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const rafRef = useRef<number>(0)
  // Set from the server's first event, so Stop and resume work even on a brand-new chat
  // whose id the client did not choose.
  const liveSessionRef = useRef<string | undefined>(undefined)
  const { approval, setApproval, decideApproval } = useEgressApproval(liveSessionRef)
  const { togglePin, deleteTurn } = useMessageActions({ messages, setMessages, setContext, setStatus, busy, sessionId, liveSessionRef, t })

  function cancel() {
    abortRef.current?.abort()
    // The connection closing no longer stops the model — the run must be cancelled explicitly.
    if (liveSessionRef.current) stopChat(liveSessionRef.current)
    setApproval(null)
  }

  async function submit(text: string, attachedFileIds?: string[]) {
    const next: Message[] = [...messages, { role: 'user', content: text, ...(hasAttachment(text) ? { pinned: true } : {}) }]
    setMessages(next)
    await run(next, text, false, attachedFileIds)
  }

  /** Re-answers the last question, replacing the previous answer. Uses whichever focus mode
   *  is selected now, so switching mode then retrying is how you "retry differently". */
  async function regenerate() {
    const retry = busy ? null : retryOf(messages)
    if (!retry) return
    setMessages(retry.history)
    await run(retry.history, retry.question, true)
  }

  async function run(next: Message[], text: string, regenerating: boolean, attachedFileIds?: string[]) {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    clearLive()
    live.setRunStartedAt(Date.now())
    setBusy(true)
    setAnswerTime('')
    const chatRun = new ChatRun({ t, setStreaming, setStreamingThinking, setStatus, setSteps, setAnswerTime, setApproval, setContext, rafRef, liveSessionRef, onSessionCreated }, text, focusMode)
    const { searchCategories, includeFileIds, includeMemoryIds, collectionIds, spaceId, notesFirst, wholeCollection } = options
    try {
      for await (const chunk of streamChat(next, focusMode, sessionId, ctrl.signal, spaceId, undefined, searchCategories, includeFileIds, includeMemoryIds, collectionIds, regenerating, notesFirst, modelId, wholeCollection, attachedFileIds)) {
        chatRun.handle(chunk)
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') chatRun.aborted = true
      else setStatus(err instanceof Error ? err.message : t('answer.requestFailed'))
    } finally {
      settle(chatRun, text, regenerating)
    }
  }

  /** Stores the answer, or explains its absence, once the stream has ended for whatever reason. */
  function settle(chatRun: ChatRun, question: string, regenerating: boolean) {
    cancelAnimationFrame(rafRef.current)
    abortRef.current = null
    const answer = chatRun.answer()
    if (answer) setMessages(prev => [...withStoredId(prev, chatRun.storedIds.user), answer])
    setStreaming('')
    setStreamingThinking('')
    chatRun.closeSteps()
    if (!chatRun.produced && !chatRun.aborted) setStatus(t('answer.noResponse'))
    else if (chatRun.aborted && !chatRun.produced) {
      // Withdraw the turn only if this run added it. `submit` appends the user's message and
      // then streams, so a stop before any text leaves a question with no answer — worth
      // removing. `regenerate` re-sends a question that was already in the transcript, and
      // popping there deleted the user's own question along with the answer they cancelled.
      if (!regenerating) setMessages(prev => prev.slice(0, -1))
      setStatus('')
    }
    setBusy(false)
    // Fire-and-forget: chips appear a moment after the answer, or not at all.
    if (followUpSuggestions && chatRun.text.length >= 200 && !chatRun.aborted && chatRun.images.length === 0) {
      fetchRelatedQuestions(question, chatRun.text).then(setRelated).catch(() => {})
    }
  }

  function reset() {
    setContext(null)
    setMessages([])
    clearLive()
    setApproval(null)
    liveSessionRef.current = undefined
  }

  const { streaming, streamingThinking, status, answerTime, related, steps, runStartedAt } = live
  return { messages, setMessages, context, setContext, togglePin, deleteTurn, streaming, streamingThinking, status, setStatus, answerTime, busy, submit, regenerate, cancel, reset, related, setRelated, steps, runStartedAt, approval, decideApproval }
}
