/** What the types cannot see about the guide: the contents of the topics, and whether a deep-link
 *  target still names a view that exists.
 *
 *  The mapped type in index.ts already fails a build when a language is missing a topic. These
 *  cover the ways a topic can be present and still wrong — empty, untranslated, or grown past the
 *  length that made it worth reading in the first place. */

import { describe, expect, test } from 'bun:test'
import { en } from './en.ts'
import { sv } from './sv.ts'
import { TOPIC_ORDER, TOPIC_TARGET, guideFor, type Guide, type TopicId } from './index.ts'
import { LANGUAGES, type Lang } from '../i18n/index.ts'

const GUIDES: Record<Lang, Guide> = { en, sv }
const ids = Object.keys(en) as TopicId[]

/** The views the sidebar can switch to, plus the settings modal. Mirrors `MainView` in App.tsx
 *  minus 'chat', which is where you already are — a topic sending you to an empty chat helps
 *  nobody. Duplicated rather than imported: this file is shared code and cannot reach the client. */
const TARGETS = new Set(['chats', 'files', 'spaces', 'monitors', 'settings'])

/** Long enough to say something, short enough to still be the short version — past this the
 *  README is the better place and the topic should be split or trimmed. */
const MAX_BODY = 2600

describe('every guide', () => {
  test('covers exactly the languages the app offers', () => {
    expect([...LANGUAGES].map(l => l.code as string).sort()).toEqual(Object.keys(GUIDES).sort())
  })

  for (const [lang, guide] of Object.entries(GUIDES)) {
    test(`${lang} has exactly the topics en has`, () => {
      expect(Object.keys(guide).sort()).toEqual([...ids].sort())
    })

    test(`${lang} leaves no field empty`, () => {
      for (const id of ids) {
        for (const field of ['title', 'summary', 'body'] as const) {
          expect({ id, field, empty: guide[id][field].trim() === '' }).toEqual({ id, field, empty: false })
        }
      }
    })

    test(`${lang} keeps every topic to one screen`, () => {
      for (const id of ids) {
        expect({ id, tooLong: guide[id].body.length > MAX_BODY }).toEqual({ id, tooLong: false })
      }
    })

    test(`${lang} is actually translated`, () => {
      // A copy-pasted English body is the failure this catches: it typechecks, renders, and reads
      // as a bug report. English is compared against itself and skipped.
      if (lang === 'en') return
      for (const id of ids) {
        expect({ id, same: guide[id].body === en[id].body }).toEqual({ id, same: false })
      }
    })
  }
})

describe('topic metadata', () => {
  test('the reading order lists every topic once', () => {
    expect([...TOPIC_ORDER].sort()).toEqual([...ids].sort())
  })

  test('every deep-link target names a real destination', () => {
    for (const [id, target] of Object.entries(TOPIC_TARGET)) {
      expect({ id, known: TARGETS.has(target) }).toEqual({ id, known: true })
    }
  })
})

describe('guideFor', () => {
  test('returns the catalog for the language asked for', () => {
    expect(guideFor('sv').gettingStarted.title).toBe(sv.gettingStarted.title)
  })

  test('falls back to English for a language with no guide', () => {
    expect(guideFor('xx' as Lang)).toBe(en)
  })
})
