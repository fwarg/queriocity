import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n.tsx'
import { ShieldAlert } from 'lucide-react'
import type { EgressApproval } from '../hooks/useChat.ts'

interface Props {
  approval: EgressApproval
  onDecide: (id: string, allow: boolean) => void
}

/** Asks before an outbound request the egress guard found suspicious is sent.
 *
 *  Declining is the safe answer and the one that happens by default, so the countdown runs down to
 *  a refusal rather than to an allow. The target is rendered in full and wrapped rather than
 *  truncated: an exfiltration payload lives at the end of the string, which is exactly what an
 *  ellipsis would hide. */
export function ApprovalPrompt({ approval, onDecide }: Props) {
  const t = useT()
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000)))

  useEffect(() => {
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [approval.expiresAt])

  const what = t(approval.kind === 'fetch' ? 'approval.fetchUrl' : 'approval.webSearch')

  return (
    <div
      role="alertdialog"
      aria-labelledby="approval-title"
      className="my-3 rounded border border-amber-600/60 bg-amber-950/30 p-4 text-sm"
    >
      <div className="flex items-center gap-2 text-amber-300">
        <ShieldAlert size={18} aria-hidden />
        <span id="approval-title" className="font-medium">
          {t('approval.title', { what })}
        </span>
      </div>

      <p className="mt-2 text-gray-300">
        {t('approval.body')} <strong>{t('approval.notSent')}</strong>
      </p>

      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-xs text-gray-200">
        {approval.target}
      </pre>

      {approval.reasons.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-gray-400">
          {approval.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onDecide(approval.id, false)}
          className="rounded bg-gray-700 px-3 py-1.5 text-white hover:bg-gray-600"
        >
          {t('approval.decline')}
        </button>
        <button
          onClick={() => onDecide(approval.id, true)}
          className="rounded border border-amber-600 px-3 py-1.5 text-amber-200 hover:bg-amber-900/40"
        >
          {t('approval.send')}
        </button>
        <span className="ml-auto text-xs text-gray-400" aria-live="off">
          {t('approval.autoDecline', { seconds: secondsLeft })}
        </span>
      </div>
    </div>
  )
}
