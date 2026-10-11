import { useSyncExternalStore } from 'react'
import { DEFAULT_THEME, toTheme, type Theme } from '@shared/theme.ts'

/** Mirrors the user's theme so the login screen and first paint use it before settings load. */
const STORAGE_KEY = 'qc.theme'
/** Browser chrome colour per theme: the page background (gray-950, mirrored in light). */
const CHROME: Record<Theme, string> = { dark: '#030712', light: '#f9fafb', eink: '#ffffff' }

const listeners = new Set<() => void>()

/** The theme last stored in this browser, or the default. */
export function storedTheme(): Theme {
  try { return toTheme(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_THEME } catch { return DEFAULT_THEME }
}

/** The theme currently applied to the document. */
export function currentTheme(): Theme {
  return toTheme(document.documentElement.dataset.theme) ?? DEFAULT_THEME
}

/** Apply `theme` to the document (index.css remaps the colour variables) and remember it. */
export function applyTheme(theme: Theme) {
  if (theme === currentTheme() && document.documentElement.dataset.theme) return
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME[theme])
  try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* private mode */ }
  listeners.forEach(fn => fn())
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** The applied theme, re-rendering on change — for colours CSS cannot reach (code highlighting). */
export const useTheme = () => useSyncExternalStore(subscribe, currentTheme)
