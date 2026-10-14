import { useState } from 'react'
import type { LogStep } from '../components/ProgressLog.tsx'

/** What is on screen for the answer in progress: its text so far, progress, status and footer. */
export function useLiveAnswer() {
  const [streaming, setStreaming] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [status, setStatus] = useState('')
  const [answerTime, setAnswerTime] = useState('')
  const [related, setRelated] = useState<string[]>([])
  const [steps, setSteps] = useState<LogStep[]>([])
  /** Start of the current run, for the timer on the transient status line (flash has no log). */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)

  /** Clears what the previous answer left on screen. */
  function clearLive() {
    setStreaming('')
    setStreamingThinking('')
    setStatus('')
    setRelated([])
    setSteps([])
  }

  return {
    streaming, setStreaming, streamingThinking, setStreamingThinking, status, setStatus,
    answerTime, setAnswerTime, related, setRelated, steps, setSteps, runStartedAt, setRunStartedAt, clearLive,
  }
}
