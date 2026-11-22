import { useState } from 'react'
import { ThumbsUp, ThumbsDown, X } from 'lucide-react'
import { FEEDBACK_REASONS, FEEDBACK_COMMENT_MAX, type FeedbackReason, type MessageFeedback } from '@shared/feedback.ts'
import { setMessageFeedback } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

const EMPTY: MessageFeedback = { rating: null, reasons: [], comment: '' }

/** Rating state for one stored answer. A thumb is saved on click, so a rating never waits on the
 *  details; reasons and comment follow when the user sends them. Reverts if the server refuses. */
export function useFeedback(sessionId: string | undefined, messageId: string | undefined, initial?: MessageFeedback) {
  const [saved, setSaved] = useState<MessageFeedback>(initial ?? EMPTY)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(false)

  async function save(next: MessageFeedback) {
    if (!sessionId || !messageId) return false
    const before = saved
    setSaved(next)
    setError(false)
    try {
      await setMessageFeedback(sessionId, messageId, next)
      return true
    } catch {
      setSaved(before)
      setError(true)
      return false
    }
  }

  /** Clicking the active thumb withdraws the rating; either thumb opens the details. */
  function rate(rating: 1 | -1) {
    const withdrawn = saved.rating === rating
    // A 👍 keeps no reasons: they all name a failure.
    void save({ ...saved, rating: withdrawn ? null : rating, reasons: rating === 1 ? [] : saved.reasons })
    setOpen(!withdrawn)
  }

  return { saved, open, error, rate, save, close: () => setOpen(false) }
}

export type FeedbackState = ReturnType<typeof useFeedback>

/** 👍/👎 for the answer's action row. */
export function FeedbackButtons({ state }: { state: FeedbackState }) {
  const t = useT()
  const { rating } = state.saved
  const tone = (active: boolean, hover: string) => `p-0.5 rounded transition-colors ${active ? 'text-blue-400' : `text-gray-600 ${hover}`}`
  return (
    <>
      <button onClick={() => state.rate(1)} className={tone(rating === 1, 'hover:text-green-400')} title={t('feedback.good')} aria-label={t('feedback.good')} aria-pressed={rating === 1}>
        <ThumbsUp size={13} />
      </button>
      <button onClick={() => state.rate(-1)} className={tone(rating === -1, 'hover:text-red-400')} title={t('feedback.bad')} aria-label={t('feedback.bad')} aria-pressed={rating === -1}>
        <ThumbsDown size={13} />
      </button>
    </>
  )
}

/** Reasons (for a 👎) and a free-text comment, under the answer once a thumb is clicked. */
export function FeedbackDetails({ state }: { state: FeedbackState }) {
  const t = useT()
  const [reasons, setReasons] = useState<FeedbackReason[]>(state.saved.reasons)
  const [comment, setComment] = useState(state.saved.comment)
  const negative = state.saved.rating === -1
  const toggle = (r: FeedbackReason) => setReasons(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])

  async function send() {
    if (await state.save({ rating: state.saved.rating, reasons: negative ? reasons : [], comment })) state.close()
  }

  if (!state.open) return state.error ? <p className="text-[11px] text-red-400 mt-1">{t('feedback.failed')}</p> : null
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-gray-700 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">{t(negative ? 'feedback.whatWasWrong' : 'feedback.anythingToAdd')}</span>
        <button onClick={state.close} className="p-0.5 rounded text-gray-500 hover:text-gray-300" title={t('common.close')} aria-label={t('common.close')}>
          <X size={13} />
        </button>
      </div>
      {negative && (
        <div className="flex flex-wrap gap-1.5">
          {FEEDBACK_REASONS.map(r => (
            <button
              key={r}
              onClick={() => toggle(r)}
              aria-pressed={reasons.includes(r)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${reasons.includes(r) ? 'border-red-500/70 bg-red-900/30 text-red-200' : 'border-gray-600 text-gray-300 hover:border-gray-500'}`}
            >
              {t(`feedback.reason.${r}`)}
            </button>
          ))}
        </div>
      )}
      <textarea
        rows={2}
        value={comment}
        maxLength={FEEDBACK_COMMENT_MAX}
        onChange={e => setComment(e.target.value)}
        placeholder={t('feedback.commentPlaceholder')}
        className="px-2 py-1.5 rounded bg-gray-900 border border-gray-700 text-xs text-gray-100 resize-none focus:outline-none focus:border-blue-500"
      />
      <div className="flex items-center justify-end gap-2">
        {state.error && <span className="text-[11px] text-red-400">{t('feedback.failed')}</span>}
        <button onClick={send} className="px-2.5 py-1 rounded bg-blue-700 hover:bg-blue-600 text-xs text-white">{t('feedback.send')}</button>
      </div>
    </div>
  )
}
