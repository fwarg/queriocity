import { ApiError } from './api.ts'
import type { TFunction } from './i18n.tsx'
import { en } from '@shared/i18n/en.ts'
import type { TranslationKey } from '@shared/i18n/index.ts'

/** What to show the user for a caught error.
 *
 *  Prefers the server's stable code, so the message is in the reader's language; falls back to the
 *  server's English string for the routes that do not send one yet, and to `fallback` for anything
 *  that is not an Error at all. The `in en` guard means an unrecognised code — an older client
 *  against a newer server — degrades to the English text rather than rendering a raw key. */
export function errorMessage(t: TFunction, err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.code) {
    const key = `error.${err.code}`
    if (key in en) return t(key as TranslationKey)
  }
  return err instanceof Error ? err.message : fallback
}
