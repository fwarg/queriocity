import { useState, useRef } from 'react'
import { streamChat } from '../lib/api.ts'
import type { Message } from '../lib/api.ts'

interface UseChatOptions {
  sessionId: string | undefined
  focusMode: 'flash' | 'fast' | 'balanced' | 'thorough'
  spaceId?: string
  onSessionCreated: (id: string, title: string) => void
}

export function useChat({ sessionId, focusMode, spaceId, onSessionCreated }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [status, setStatus] = useState('')
  const [answerTime, setAnswerTime] = useState('')
  const [busy, setBusy] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const rafRef = useRef<number>(0)

  function cancel() {
    abortRef.current?.abort()
  }

  async function submit(text: string) {
    const ctrl = new AbortController()
    abortRef.current = ctrl

    const userMsg: Message = { role: 'user', content: text }
    const next = [...messages, userMsg]
    setMessages(next)
    setBusy(true)
    setAnswerTime('')
    setStreaming('')
    setStreamingThinking('')

    let accumulated = ''
    let thinkingAccumulated = ''
    const sources: Array<{ title: string; url: string }> = []
    const fileSources: Array<{ title: string; url: string }> = []
    const images: Array<{ url: string; alt: string }> = []
    let wasAborted = false

    try {
      for await (const chunk of streamChat(next, focusMode, sessionId, ctrl.signal, spaceId)) {
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
          sources.push(...(chunk.sources as Array<{ title: string; url: string }>))
        } else if (chunk.type === 'file_sources') {
          fileSources.push(...(chunk.sources as Array<{ title: string; url: string }>))
        } else if (chunk.type === 'done') {
          if (chunk.elapsedMs) {
            const label = images.length > 0 ? 'Generated in' : 'Answered in'
            setAnswerTime(`${label} ${(chunk.elapsedMs as number / 1000).toFixed(1)} seconds.`)
          }
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
      else if (!accumulated) setStatus('')
      setBusy(false)
    }
  }

  function reset() {
    setMessages([])
    setStreaming('')
    setStreamingThinking('')
    setStatus('')
  }

  return { messages, setMessages, streaming, streamingThinking, status, setStatus, answerTime, busy, submit, cancel, reset }
}
