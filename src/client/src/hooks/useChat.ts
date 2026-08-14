import { useState, useRef } from 'react'
import { streamChat, stopChat, fetchRelatedQuestions, decideEgress } from '../lib/api.ts'
import type { Message, Source } from '../lib/api.ts'
import type { LogStep } from '../components/ProgressLog.tsx'

export interface EgressApproval {
  id: string
  kind: 'fetch' | 'search'
  /** Shown to the user in full. Never truncate it — a payload hides in the tail. */
  target: string
  reasons: string[]
  /** Wall-clock deadline, so the countdown survives a re-render. */
  expiresAt: number
}

interface UseChatOptions {
  sessionId: string | undefined
  focusMode: 'flash' | 'balanced' | 'thorough' | 'image'
  searchCategories?: Array<'news' | 'science' | 'discussions' | 'tech'>
  includeFileIds?: string[]
  includeMemoryIds?: string[]
  spaceId?: string
  /** User setting; when false no related-questions call is made at all. */
  followUpSuggestions?: boolean
  onSessionCreated: (id: string, title: string) => void
}

export function useChat({ sessionId, focusMode, searchCategories, includeFileIds, includeMemoryIds, spaceId, followUpSuggestions = true, onSessionCreated }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [status, setStatus] = useState('')
  const [answerTime, setAnswerTime] = useState('')
  const [busy, setBusy] = useState(false)

  const [related, setRelated] = useState<string[]>([])
  const [steps, setSteps] = useState<LogStep[]>([])
  /** Start of the current run, for the timer on the transient status line (flash has no log). */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  /** Outbound request awaiting the user's decision, or null. At most one is ever parked: the
   *  generation blocks on it, so a second cannot be raised until this one resolves. */
  const [approval, setApproval] = useState<EgressApproval | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const rafRef = useRef<number>(0)
  // Set from the server's first event, so Stop and resume work even on a brand-new chat
  // whose id the client did not choose.
  const liveSessionRef = useRef<string | undefined>(undefined)

  function cancel() {
    abortRef.current?.abort()
    // The connection closing no longer stops the model — the run must be cancelled explicitly.
    if (liveSessionRef.current) stopChat(liveSessionRef.current)
    setApproval(null)
  }

  /** Answers a parked egress prompt. Clearing it locally regardless of the server's reply is
   *  deliberate: if nothing was parked the request had already been refused by the timeout, and
   *  leaving the dialog up would invite a second click that means nothing. */
  async function decideApproval(id: string, allow: boolean) {
    setApproval(a => (a && a.id === id ? null : a))
    if (liveSessionRef.current) await decideEgress(liveSessionRef.current, id, allow)
  }

  async function submit(text: string) {
    const next: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    await run(next, text, false)
  }

  /** Re-answers the last question, replacing the previous answer. Uses whichever focus mode
   *  is selected now, so switching mode then retrying is how you "retry differently". */
  async function regenerate() {
    if (busy) return
    const lastAnswer = messages.findLastIndex(m => m.role === 'assistant')
    if (lastAnswer === -1) return
    const history = messages.slice(0, lastAnswer)
    const lastUser = [...history].reverse().find(m => m.role === 'user')
    if (!lastUser) return
    setMessages(history)
    await run(history, lastUser.content, true)
  }

  async function run(next: Message[], text: string, regenerating: boolean) {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRelated([])
    setSteps([])
    setRunStartedAt(Date.now())
    setBusy(true)
    setAnswerTime('')
    setStatus('')
    setStreaming('')
    setStreamingThinking('')

    // Built here rather than in the component so a step's end time is the moment the next one
    // arrives, not the moment React happened to re-render.
    const log: LogStep[] = []
    const closeLastStep = () => {
      const last = log[log.length - 1]
      if (last && last.endedAt === undefined) last.endedAt = Date.now()
    }
    const pushStep = (step: Omit<LogStep, 'startedAt'>) => {
      closeLastStep()
      log.push({ ...step, startedAt: Date.now() })
      setSteps([...log])
    }

    let accumulated = ''
    let thinkingAccumulated = ''
    const sources: Source[] = []
    const fileSources: Array<{ title: string; url: string }> = []
    const images: Array<{ url: string; alt: string }> = []
    const blockedEngines: Array<{ engine: string; reason: string }> = []
    let wasAborted = false

    try {
      for await (const chunk of streamChat(next, focusMode, sessionId, ctrl.signal, spaceId, undefined, searchCategories, includeFileIds, includeMemoryIds, regenerating)) {
        if (chunk.type === 'text') {
          accumulated += chunk.delta as string
          cancelAnimationFrame(rafRef.current)
          const snap = accumulated
          rafRef.current = requestAnimationFrame(() => setStreaming(snap))
          setStatus('')
          // The answer starting is what ends the last step and collapses the log.
          if (log.length && log[log.length - 1].endedAt === undefined) {
            closeLastStep()
            setSteps([...log])
          }
        } else if (chunk.type === 'session') {
          // The server's first event. Stop, resume and egress approvals all address the run by
          // session id, so a new chat has none to give them until this arrives.
          liveSessionRef.current = chunk.sessionId as string
        } else if (chunk.type === 'image') {
          images.push({ url: chunk.url as string, alt: chunk.alt as string })
          setStatus('')
        } else if (chunk.type === 'thinking') {
          thinkingAccumulated += chunk.delta as string
          setStreamingThinking(thinkingAccumulated)
        } else if (chunk.type === 'status') {
          // A status carrying `step` is a log entry; a bare one is the transient line it has
          // always been (errors, and flash, which has a single phase and so no log to build).
          if (chunk.step) pushStep({ ...(chunk.step as Omit<LogStep, 'startedAt' | 'text'>), text: chunk.text as string })
          else setStatus(chunk.text as string)
        } else if (chunk.type === 'sources') {
          sources.push(...(chunk.sources as Source[]))
        } else if (chunk.type === 'file_sources') {
          fileSources.push(...(chunk.sources as Array<{ title: string; url: string }>))
        } else if (chunk.type === 'approval') {
          setApproval({
            id: chunk.id as string,
            kind: chunk.kind as 'fetch' | 'search',
            target: chunk.target as string,
            reasons: chunk.reasons as string[],
            expiresAt: Date.now() + (chunk.timeoutMs as number),
          })
        } else if (chunk.type === 'approval_time') {
          // Resume correcting a replayed countdown against the server's real deadline.
          setApproval(a => a && a.id === chunk.id
            ? { ...a, expiresAt: Date.now() + (chunk.timeoutMs as number) }
            : a)
        } else if (chunk.type === 'approval_closed') {
          setApproval(a => (a && a.id === chunk.id ? null : a))
        } else if (chunk.type === 'search_warning') {
          blockedEngines.push(...(chunk.engines as Array<{ engine: string; reason: string }>))
        } else if (chunk.type === 'done') {
          if (chunk.elapsedMs) {
            const label = images.length > 0 ? 'Generated in' : 'Answered in'
            const srcCount = sources.length
            // Zero sources only means "the search came up empty" in the modes that always
            // search. Flash never searches, and image searches at its own discretion without
            // reporting sources, so for those a count of zero says nothing and is left out.
            const alwaysSearches = focusMode === 'balanced' || focusMode === 'thorough'
            let srcLabel: string
            if (srcCount > 0) srcLabel = ` · ${srcCount} search result${srcCount === 1 ? '' : 's'}`
            else if (blockedEngines.length) srcLabel = ` · search engines unavailable (${blockedEngines.map(e => e.engine).join(', ')}) — answered without web results`
            else srcLabel = alwaysSearches ? ' · no search results' : ''
            setAnswerTime(`${label} ${(chunk.elapsedMs as number / 1000).toFixed(1)} seconds${srcLabel}.`)
          }
          liveSessionRef.current = chunk.sessionId as string
          onSessionCreated(chunk.sessionId as string, (chunk.title as string | undefined) ?? text.slice(0, 60))
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        wasAborted = true
      } else {
        setStatus(err instanceof Error ? err.message : 'Request failed. Check your connection.')
      }
    } finally {
      cancelAnimationFrame(rafRef.current)
      abortRef.current = null
      if (accumulated || images.length > 0) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: accumulated,
          sources,
          fileSources: fileSources.length > 0 ? fileSources : undefined,
          thinking: thinkingAccumulated || undefined,
          images: images.length > 0 ? images : undefined,
        }])
      }
      setStreaming('')
      setStreamingThinking('')
      closeLastStep()
      setSteps([...log])
      if (!accumulated && !wasAborted) setStatus('No response received — search may be temporarily unavailable. Try again.')
      else if (wasAborted && !accumulated && images.length === 0) {
        // Withdraw the turn only if this run added it. `submit` appends the user's message and
        // then streams, so a stop before any text leaves a question with no answer — worth
        // removing. `regenerate` re-sends a question that was already in the transcript, and
        // popping there deleted the user's own question along with the answer they cancelled.
        if (!regenerating) setMessages(prev => prev.slice(0, -1))
        setStatus('')
      }
      setBusy(false)
      // Fire-and-forget: chips appear a moment after the answer, or not at all.
      if (followUpSuggestions && accumulated.length >= 200 && !wasAborted && images.length === 0) {
        fetchRelatedQuestions(text, accumulated).then(setRelated).catch(() => {})
      }
    }
  }

  function reset() {
    setMessages([])
    setStreaming('')
    setStreamingThinking('')
    setStatus('')
    setRelated([])
    setSteps([])
    setApproval(null)
    liveSessionRef.current = undefined
  }

  return { messages, setMessages, streaming, streamingThinking, status, setStatus, answerTime, busy, submit, regenerate, cancel, reset, related, setRelated, steps, runStartedAt, approval, decideApproval }
}
