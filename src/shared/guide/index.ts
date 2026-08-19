/** The in-app guide: what it is made of, and where each topic can send you.
 *
 *  Structured like `../i18n/` on purpose — `en` defines the type and every other language is
 *  checked against it, so a topic that never got translated is a `tsc` error rather than an
 *  English page in a Swedish interface. The prose lives here rather than in the i18n catalogs
 *  because it is paragraphs of markdown, not interface chrome, and it is loaded on demand. */

import type { Lang } from '../i18n/index.ts'
import { en } from './en.ts'
import { sv } from './sv.ts'

export interface Topic {
  title: string
  /** One line under the title in the topic list — what the topic answers. */
  summary: string
  /** Markdown, rendered by the same react-markdown the chat answers use. */
  body: string
}

export type TopicId = keyof typeof en

export type Guide = { [K in TopicId]: Topic }

/** The order the topic list is read in: what the app is, then what you do with it, then the
 *  things you reach for later. Object key order would work until someone sorted the file. */
export const TOPIC_ORDER: readonly TopicId[] = [
  'gettingStarted', 'modes', 'sources', 'resources', 'notes', 'spaces',
  'collections', 'monitors', 'templates', 'images', 'privacy', 'settings',
]

/** Where a topic's "Open …" button can send you — the sidebar views, plus the settings modal.
 *  'chat' is deliberately absent: sending someone to the chat they are already in helps nobody. */
export type GuideTarget = 'chats' | 'files' | 'spaces' | 'monitors' | 'settings'

/** Kept out of the catalogs deliberately: a destination is not translatable copy, and a
 *  translator editing one cannot break navigation. */
export const TOPIC_TARGET: Partial<Record<TopicId, GuideTarget>> = {
  gettingStarted: 'chats',
  resources: 'files',
  notes: 'files',
  spaces: 'spaces',
  collections: 'spaces',
  monitors: 'monitors',
  privacy: 'spaces',
  settings: 'settings',
}

const GUIDES: Record<Lang, Guide> = { en, sv }

/** Falls back to English per language, not per topic — a whole catalog is either there or it is
 *  not, and the type system is what guarantees a present one is complete. */
export const guideFor = (lang: Lang): Guide => GUIDES[lang] ?? en
