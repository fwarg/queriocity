import { useEffect } from 'react'
import type { AuthUser } from '../lib/api.ts'
import { useLang } from '../lib/i18n.tsx'
import { applyTheme } from '../lib/theme.ts'
import { DEFAULT_THEME } from '@shared/theme.ts'

/** Applies the signed-in user's language, font size and theme to the page. */
export function useUserPreferences(user: AuthUser | null) {
  const { setLang } = useLang()

  // The signed-in setting wins over the browser guess the provider started from. One-way: the
  // provider never writes back to user settings, so this cannot loop against a settings save.
  const userLang = user?.settings?.language
  useEffect(() => { if (userLang) setLang(userLang) }, [userLang, setLang])

  const fontSize = user?.settings?.fontSize ?? 17
  useEffect(() => {
    const boost = 2
    document.documentElement.style.fontSize =
      `clamp(${fontSize}px, calc(${fontSize}px + ${boost} * (1440px - 100vw) / 1065), ${fontSize + boost}px)`
  }, [fontSize])

  // Signed out, the theme stored in this browser stays (theme-init.js applied it before paint).
  const theme = user ? user.settings?.theme ?? DEFAULT_THEME : undefined
  useEffect(() => { if (theme) applyTheme(theme) }, [theme])
}
