import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { DEFAULT_LANG, resolveLang, toLang, translate, type Lang, type TranslationKey, type Vars } from '@shared/i18n/index.ts'

/** React binding for the shared catalogs. Kept client-side: the server has no React, and the
 *  catalogs themselves live in src/shared so the server can reach them without this file. */

const LangContext = createContext<{ lang: Lang; setLang: Dispatch<SetStateAction<Lang>> }>({
  lang: DEFAULT_LANG,
  setLang: () => {},
})

/** Where the language lives before there is a user to store it on. Written on every change so a
 *  returning visitor's login page is already in their language — the signed-in setting overrides
 *  it as soon as /me resolves. */
const STORAGE_KEY = 'qc.lang'

export function storedLang(): Lang {
  try {
    return toLang(localStorage.getItem(STORAGE_KEY)) ?? resolveLang(navigator.languages)
  } catch {
    // Safari in private mode throws on localStorage access rather than returning null.
    return resolveLang(navigator.languages)
  }
}

/** Owns the active language for the whole app, including the signed-out screens.
 *
 *  Deliberately not fed from a prop: App reaches the auth screens through early returns, so there
 *  is no single place in its tree above both. Instead this holds the state and App pushes the
 *  signed-in user's setting in with `setLang` once /me resolves. Persisting to the server stays
 *  App's job — this provider only ever writes localStorage, so syncing a value *out of* user
 *  settings can never PATCH it straight back. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(storedLang)

  useEffect(() => {
    document.documentElement.lang = lang
    try { localStorage.setItem(STORAGE_KEY, lang) } catch { /* private mode */ }
  }, [lang])

  const value = useMemo(() => ({ lang, setLang }), [lang])
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

export function useLang() {
  return useContext(LangContext)
}

export type TFunction = (key: TranslationKey, vars?: Vars) => string

/** The translator for the active language. Identity is stable per language, so it can sit in a
 *  dependency array without re-running the effect on every render. */
export function useT(): TFunction {
  const { lang } = useContext(LangContext)
  return useCallback((key, vars) => translate(lang, key, vars), [lang])
}
