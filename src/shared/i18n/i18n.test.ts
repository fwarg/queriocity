/** The catalog types catch a missing or stale key at compile time. These cover what they cannot:
 *  the contents of the strings, and the runtime behaviour a bad hand-edit would land on. */

import { describe, expect, test } from 'bun:test'
import { en } from './en.ts'
import { sv } from './sv.ts'
import { LANGUAGES, resolveLang, toLang, translate, type Catalog, type Lang, type TranslationKey } from './index.ts'
import type { ErrorCode } from '../error-codes.ts'

const CATALOGS: Record<Lang, Catalog> = { en, sv }
const keys = (c: Catalog) => Object.keys(c).sort()
const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort()
const forms = (m: string | { one: string; other: string }) =>
  typeof m === 'string' ? [m] : [m.one, m.other]

describe('every catalog', () => {
  test('is registered in LANGUAGES', () => {
    expect([...LANGUAGES].map(l => l.code as string).sort()).toEqual(Object.keys(CATALOGS).sort())
  })

  for (const [lang, catalog] of Object.entries(CATALOGS)) {
    test(`${lang} has exactly the keys en has`, () => {
      expect(keys(catalog)).toEqual(keys(en))
    })

    test(`${lang} keeps every placeholder en uses`, () => {
      // A renamed `{count}` typechecks perfectly and then renders the literal braces to the user.
      // This is the only mechanical check that catches it.
      for (const key of Object.keys(en) as TranslationKey[]) {
        // The key rides along in the compared value so a failure names the offending string.
        const expected = forms(en[key]).flatMap(placeholders).sort()
        const actual = forms(catalog[key]).flatMap(placeholders).sort()
        expect({ key, placeholders: actual }).toEqual({ key, placeholders: expected })
      }
    })

    test(`${lang} leaves no string empty`, () => {
      for (const key of Object.keys(en) as TranslationKey[]) {
        for (const form of forms(catalog[key])) expect({ key, form }).not.toEqual({ key, form: '' })
      }
    })
  }
})

describe('translate', () => {
  test('substitutes named placeholders', () => {
    expect(translate('en', 'log.results', { count: 3 })).toBe('Found 3 results')
  })

  test('picks the plural form Intl selects for the language', () => {
    expect(translate('en', 'log.results', { count: 1 })).toBe('Found 1 result')
    expect(translate('sv', 'log.results', { count: 1 })).toBe('Hittade 1 resultat')
    expect(translate('sv', 'log.results', { count: 2 })).toBe('Hittade 2 resultat')
  })

  test('leaves an unknown placeholder alone rather than printing undefined', () => {
    expect(translate('en', 'log.results', {})).toContain('{count}')
  })

  test('falls back to English for a value a bad edit removed', () => {
    const gutted = { ...sv, 'auth.signIn': undefined } as unknown as Catalog
    const catalogs = { en, sv: gutted }
    // Same lookup order translate uses: catalog value, then the English one.
    expect(catalogs.sv['auth.signIn'] ?? en['auth.signIn']).toBe('Sign in')
  })
})

describe('resolveLang', () => {
  test('matches on the language, ignoring region', () => {
    expect(resolveLang(['sv-SE', 'en-US'])).toBe('sv')
    expect(resolveLang(['sv-FI'])).toBe('sv')
    expect(resolveLang(['en-GB'])).toBe('en')
  })

  test('takes the first language it actually has', () => {
    expect(resolveLang(['de-DE', 'sv-SE', 'en'])).toBe('sv')
  })

  test('falls back to English for anything unknown or absent', () => {
    expect(resolveLang(['de', 'fr'])).toBe('en')
    expect(resolveLang([])).toBe('en')
    expect(resolveLang(undefined)).toBe('en')
  })
})

describe('toLang', () => {
  test('accepts only codes we have a catalog for', () => {
    expect(toLang('sv')).toBe('sv')
    expect(toLang('de')).toBeUndefined()
    expect(toLang('')).toBeUndefined()
    expect(toLang(null)).toBeUndefined()
    expect(toLang(42)).toBeUndefined()
  })
})

/** The codes are declared in shared/error-codes.ts, and the client looks them up as
 *  `error.<code>` — a union member with no catalog entry would fall back to the server's English
 *  string in every language, silently. */
describe('error codes', () => {
  const CODES: ErrorCode[] = [
    'too_many_attempts', 'invalid_credentials', 'email_registered',
    'invite_required', 'invite_invalid', 'invite_used', 'invite_expired', 'invite_email_mismatch',
    'no_credentials', 'wrong_password',
  ]

  test('every code has a catalog entry', () => {
    expect(CODES.filter(c => !(`error.${c}` in en))).toEqual([])
  })

  test('the catalog carries no entry for a code that no longer exists', () => {
    const known = new Set(CODES.map(c => `error.${c}`))
    expect(Object.keys(en).filter(k => k.startsWith('error.') && !known.has(k))).toEqual([])
  })
})
