import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Guide, GuideTarget, TopicId } from '@shared/guide/index.ts'
import { useT, useLang } from '../lib/i18n.tsx'
import type { TranslationKey } from '@shared/i18n/index.ts'
import { Modal } from './Modal.tsx'
import { PRIMARY_BTN } from './ui.tsx'

/** The whole guide module, loaded on demand. A type-only reference here, so the twelve topics in
 *  two languages stay out of the initial bundle — they are prose nobody has asked for yet. */
type GuideModule = typeof import('@shared/guide/index.ts')

type Navigate = (target: GuideTarget) => void

/** What the "Open …" button calls each destination — the sidebar's own words for it. */
const TARGET_LABEL: Record<GuideTarget, TranslationKey> = {
  chats: 'nav.chats',
  files: 'nav.resources',
  spaces: 'nav.workspaces',
  monitors: 'nav.monitors',
  settings: 'nav.settings',
}

interface GuideApi {
  /** Opens the panel on a topic. Defaults to the first one, for the sidebar entry. */
  open: (topic?: TopicId) => void
  /** App tells the guide how to reach a view; see `useGuideNavigation`. */
  setNavigate: (fn: Navigate) => void
}

const GuideContext = createContext<GuideApi | null>(null)

/** Opens the guide, from anywhere. A context rather than a prop because the ⓘ that links into it
 *  lives in five different views, none of which have a path to App's state. */
export function useGuide(): (topic?: TopicId) => void {
  const api = useContext(GuideContext)
  if (!api) throw new Error('useGuide used outside GuideProvider')
  return api.open
}

/** App registers how to switch views, so a topic's "Open Spaces →" button can do it. */
export function useGuideNavigation(navigate: Navigate) {
  const api = useContext(GuideContext)
  useEffect(() => { api?.setNavigate(navigate) }, [api, navigate])
}

/** "Read more →", for a panel that explains something in a sentence and has more to say. Used
 *  where a full SectionHeader would not fit: a popup, a settings row, a subsection. */
export function GuideLink({ topic }: { topic: TopicId }) {
  const t = useT()
  const openGuide = useGuide()
  return (
    <button type="button" onClick={() => openGuide(topic)} className="text-blue-400 hover:underline">
      {t('guide.readMore')} →
    </button>
  )
}

export function GuideProvider({ children }: { children: React.ReactNode }) {
  const [topic, setTopic] = useState<TopicId | null>(null)
  const navigateRef = useRef<Navigate | null>(null)

  const api = useMemo<GuideApi>(() => ({
    open: (t?: TopicId) => setTopic(t ?? 'gettingStarted'),
    setNavigate: fn => { navigateRef.current = fn },
  }), [])

  const close = useCallback(() => setTopic(null), [])

  const go = useCallback((target: GuideTarget) => {
    setTopic(null)
    navigateRef.current?.(target)
  }, [])

  return (
    <GuideContext.Provider value={api}>
      {children}
      {topic && <GuidePanel initial={topic} onClose={close} onNavigate={go} />}
    </GuideContext.Provider>
  )
}

/** Headings and lists sized for a modal. The map in MessageList is chat-specific — citations, SVG
 *  blocks, image downloads — and none of that applies to a page of prose. */
const MARKDOWN: Components = {
  p: ({ children }) => <p className="text-sm text-gray-300 leading-relaxed mb-3">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 mb-3 flex flex-col gap-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 flex flex-col gap-1">{children}</ol>,
  li: ({ children }) => <li className="text-sm text-gray-300 leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-gray-100">{children}</strong>,
  em: ({ children }) => <em className="text-gray-400">{children}</em>,
  code: ({ children }) => <code className="px-1 py-0.5 rounded bg-gray-800 text-xs text-gray-200">{children}</code>,
  a: ({ href, children }) => <a href={href} className="text-blue-400 hover:underline">{children}</a>,
}

function GuidePanel({ initial, onClose, onNavigate }: {
  initial: TopicId
  onClose: () => void
  onNavigate: (target: GuideTarget) => void
}) {
  const t = useT()
  const { lang } = useLang()
  const [mod, setMod] = useState<GuideModule | null>(null)
  const [selected, setSelected] = useState<TopicId | null>(initial)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    import('@shared/guide/index.ts').then(m => { if (alive) setMod(m) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Escape closes the guide and nothing behind it. The guide is often opened *over* another modal
  // — Settings has a link into it — and Modal listens on `document`, so without a capture-phase
  // stop both would close and an unsaved settings form would go with them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Re-opening on a different topic while the panel is already up — the ⓘ links do this.
  useEffect(() => setSelected(initial), [initial])

  const guide: Guide | null = mod ? mod.guideFor(lang) : null
  const matches = useMemo(() => {
    if (!mod || !guide) return []
    const q = query.trim().toLowerCase()
    return mod.TOPIC_ORDER.filter(id => {
      if (!q) return true
      const { title, summary, body } = guide[id]
      return `${title} ${summary} ${body}`.toLowerCase().includes(q)
    })
  }, [mod, guide, query])

  const target = mod && selected ? mod.TOPIC_TARGET[selected] : undefined

  return (
    <Modal title={t('nav.guide')} onClose={onClose} maxWidth="max-w-3xl">
      {!guide || !mod ? (
        <p className="text-sm text-gray-500">{t('common.loading')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[13rem_1fr]">
          {/* One pane at a time on a phone: a 13rem list beside an article is unreadable there,
              and the article is what you came for. */}
          <div className={`flex flex-col gap-2 min-w-0 ${selected ? 'hidden md:flex' : ''}`}>
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('guide.search')}
              className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
            />
            {matches.length === 0 && <p className="text-xs text-gray-600">{t('guide.noMatch')}</p>}
            {matches.map(id => (
              <button
                key={id}
                type="button"
                onClick={() => setSelected(id)}
                className={`text-left px-2 py-1.5 rounded ${selected === id ? 'bg-gray-800' : 'hover:bg-gray-800/60'}`}
              >
                <span className={`block text-sm ${selected === id ? 'text-gray-100' : 'text-gray-300'}`}>
                  {guide[id].title}
                </span>
                <span className="block text-xs text-gray-500">{guide[id].summary}</span>
              </button>
            ))}
          </div>

          {selected && (
            <article className="flex flex-col gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="md:hidden flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 self-start"
              >
                <ArrowLeft size={12} /> {t('guide.back')}
              </button>
              <h3 className="text-base font-semibold text-gray-100">{guide[selected].title}</h3>
              <div className="min-w-0">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
                  {guide[selected].body}
                </ReactMarkdown>
              </div>
              {target && (
                <button type="button" onClick={() => onNavigate(target)} className={`${PRIMARY_BTN} self-start`}>
                  {t('guide.openTarget', { name: t(TARGET_LABEL[target]) })}
                  <ArrowRight size={12} className="inline ml-1 -mt-0.5" />
                </button>
              )}
            </article>
          )}
        </div>
      )}
    </Modal>
  )
}
