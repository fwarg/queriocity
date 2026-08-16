/** The whole language mechanism: what a language is, and how a key becomes a string.
 *
 *  Adding a language is two edits — a catalog file typed as `Catalog`, and a row in `LANGUAGES`.
 *  Everything else (the selector, the settings schema, the persisted value) reads `LANGUAGES`, so
 *  nothing else needs to know the set has grown. */

import { en } from './en.ts'
import { sv } from './sv.ts'

/** The registry. Flags are emoji so there are no assets to serve and nothing for the CSP to block.
 *  A flag is a country rather than a language — deliberate, because a flag is what people scan for
 *  in a picker; the label carries the language's own name, which is what actually identifies it. */
export const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'sv', label: 'Svenska', flag: '🇸🇪' },
] as const

export type Lang = typeof LANGUAGES[number]['code']

/** The codes as a non-empty tuple, for `z.enum` on the routes that persist the setting — so a new
 *  language never needs a second list kept in step by hand. */
export const LANG_CODES = LANGUAGES.map(l => l.code) as unknown as [Lang, ...Lang[]]

export type TranslationKey = keyof typeof en

/** What a new language must supply: every key `en` has, with plurals still plural.
 *
 *  This mapped type is the entire "easy to add a language" claim — a missing key, a stale one left
 *  behind after `en` changed, or a counted string written as a bare string all fail `tsc` rather
 *  than surfacing as English text in a Swedish UI months later. */
export type Catalog = {
  [K in TranslationKey]: typeof en[K] extends string ? string : { one: string; other: string }
}

const CATALOGS: Record<Lang, Catalog> = { en, sv }

export const DEFAULT_LANG: Lang = 'en'

const isLang = (v: string): v is Lang => LANGUAGES.some(l => l.code === v)

/** Best match for a browser's language list, e.g. `['sv-SE', 'en']` → `sv`.
 *  Region is dropped: we translate languages, not locales, so `sv-FI` is still Swedish. */
export function resolveLang(preferred: readonly string[] | undefined): Lang {
  for (const tag of preferred ?? []) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLang(base)) return base
  }
  return DEFAULT_LANG
}

/** Narrows an untrusted value — a stored setting, a URL param — to a language we actually have. */
export function toLang(v: unknown): Lang | undefined {
  return typeof v === 'string' && isLang(v) ? v : undefined
}

export type Vars = Record<string, string | number>

/** Resolves one key against one language.
 *
 *  Falls back to English per key rather than per catalog: a hand-edited file with one value
 *  deleted then renders English for that line instead of a raw key, which is the failure mode
 *  worth having. The type system is the real guard; this is what is left when it is bypassed. */
export function translate(lang: Lang, key: TranslationKey, vars?: Vars): string {
  const message = (CATALOGS[lang] ?? CATALOGS[DEFAULT_LANG])[key] ?? en[key]
  if (message === undefined) return key
  return interpolate(plural(message, lang, vars), vars)
}

function plural(message: string | { one: string; other: string }, lang: Lang, vars?: Vars): string {
  if (typeof message === 'string') return message
  // Intl owns the rules, so a language with categories we do not model (`few`, `many`) degrades to
  // `other` rather than to a wrong form invented here.
  const category = new Intl.PluralRules(lang).select(Number(vars?.count ?? 0))
  return category === 'one' ? message.one : message.other
}

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole)
}
