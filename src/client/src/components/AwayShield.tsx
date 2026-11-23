import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useT } from '../lib/i18n.tsx'

/** Whether the window is hidden or has lost focus; always false while `enabled` is off. */
export function useAway(enabled: boolean): boolean {
  const [away, setAway] = useState(false)
  useEffect(() => {
    if (!enabled) { setAway(false); return }
    const update = () => setAway(document.hidden || !document.hasFocus())
    update()
    const toAway = () => setAway(true)
    window.addEventListener('blur', toAway)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('blur', toAway)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [enabled])
  return away
}

/** Opaque cover over the whole window while a locked chat is open and the window is away. Hides the
 *  pixels from screenshots, app-switcher previews and screen-reading assistants opened over another
 *  window; it does not hide the page's DOM from the browser or its extensions. Opaque, not blurred:
 *  large headings stay legible through a blur. */
export function AwayShield({ show }: { show: boolean }) {
  const t = useT()
  if (!show) return null
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-2 bg-gray-950 text-gray-400" role="presentation">
      <ShieldCheck size={28} aria-hidden />
      <span className="text-sm">{t('chat.awayHidden')}</span>
    </div>
  )
}
