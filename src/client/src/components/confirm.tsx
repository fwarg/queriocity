import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useT } from '../lib/i18n.tsx'

interface ConfirmRequest {
  message: string
  /** Verb on the affirmative button — "Delete", "Make this a space". Defaults to a neutral one. */
  confirmLabel?: string
  /** Red button. For anything that destroys something or cannot be undone. */
  danger?: boolean
}

type Ask = (req: ConfirmRequest) => Promise<boolean>

const ConfirmContext = createContext<Ask | null>(null)

/** Ask before doing something irreversible. Resolves false on cancel, Escape or a backdrop click.
 *
 *  Replaces `window.confirm`, which cannot be styled, cannot be translated beyond the message
 *  itself, labels its buttons "OK"/"Cancel" whatever the action was, and — the reason it matters
 *  here — some mobile browsers let a site suppress it entirely after the first one. */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext)
  if (!ask) throw new Error('useConfirm used outside ConfirmProvider')
  return ask
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const t = useT()
  const [pending, setPending] = useState<{ req: ConfirmRequest; resolve: (ok: boolean) => void } | null>(null)

  const ask = useCallback<Ask>(req => new Promise(resolve => setPending({ req, resolve })), [])

  const settle = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { pending.resolve(false); setPending(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending])

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {/* Rendered after the children, so it sits above a Modal at the same z-index — several of
          these are asked from inside one. */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => settle(false)}>
          <div
            role="dialog"
            aria-modal="true"
            className="bg-gray-900 border border-gray-700 rounded-lg p-5 flex flex-col gap-4 w-full max-w-sm shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-sm text-gray-200 whitespace-pre-line">{pending.req.message}</p>
            <div className="flex justify-end gap-2">
              {/* Cancel takes focus: Enter on a dialog you did not expect should not confirm it. */}
              <button
                autoFocus
                onClick={() => settle(false)}
                className="px-3 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-gray-200"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => settle(true)}
                className={`px-3 py-1.5 rounded text-sm text-white ${pending.req.danger ? 'bg-red-700 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-500'}`}
              >
                {pending.req.confirmLabel ?? t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
