import { useState, useRef } from 'react'
import { streamChat, stopChat, fetchRelatedQuestions } from '../lib/api.ts'
import type { Message, Source } from '../lib/api.ts'

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

  const abortRef = useRef<AbortController | null>(null)
  const rafRef = useRef<number>(0)
  // Set from the server's first event, so Stop and resume work even on a brand-new chat
  // whose id the client did not choose.
  const liveSessionRef = useRef<string | undefined>(undefined)

  function cancel() {
    abortRef.current?.abort()
    // The connection closing no longer stops the model — the run must be cancelled explicitly.
    if (liveSessionRef.current) stopChat(liveSessionRef.current)
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
    setBusy(true)
    setAnswerTime('')
    setStreaming('')
    setStreamingThinking('')

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
        } else if (chunk.type === 'image') {
          images.push({ url: chunk.url as string, alt: chunk.alt as string })
          setStatus('')
        } else if (chunk.type === 'thinking') {
          thinkingAccumulated += chunk.delta as string
          setStreamingThinking(thinkingAccumulated)
        } else if (chunk.type === 'status') {
          setStatus(chunk.text as string)
        } else if (chunk.type === 'sources') {
          sources.push(...(chunk.sources as Source[]))
        } else if (chunk.type === 'file_sources') {
          fileSources.push(...(chunk.sources as Array<{ title: string; url: string }>))
        } else if (chunk.type === 'search_warning') {
          blockedEngines.push(...(chunk.engines as Array<{ engine: string; reason: string }>))
        } else if (chunk.type === 'done') {
          if (chunk.elapsedMs) {
            const label = images.length > 0 ? 'Generated in' : 'Answered in'
            const srcCount = sources.length
            let srcLabel: string
            if (srcCount > 0) srcLabel = ` · ${srcCount} search result${srcCount === 1 ? '' : 's'}`
            else if (blockedEngines.length) srcLabel = ` · search engines unavailable (${blockedEngines.map(e => e.engine).join(', ')}) — answered without web results`
            else srcLabel = ' · no search results'
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
      if (!accumulated && !wasAborted) setStatus('No response received — search may be temporarily unavailable. Try again.')
      else if (wasAborted && !accumulated && images.length === 0) {
        setMessages(prev => prev.slice(0, -1))
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
    liveSessionRef.current = undefined
  }

  return { messages, setMessages, streaming, streamingThinking, status, setStatus, answerTime, busy, submit, regenerate, cancel, reset, related, setRelated }
}
