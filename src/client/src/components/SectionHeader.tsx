import { useState } from 'react'
import { Info } from 'lucide-react'
import type { TopicId } from '@shared/guide/index.ts'
import { useGuide } from './GuideView.tsx'
import { useT } from '../lib/i18n.tsx'

/** A view heading with an optional ⓘ that folds an explanation open beneath it.
 *
 *  A button rather than a `title` tooltip: hover does not exist on a touch screen, and these texts
 *  are worth the least on the screen where a tooltip would hide them. Folded shut by default —
 *  once you know how a view works, the explanation is clutter. */
export function SectionHeader({ title, intro, about, topic, titleClassName, children }: {
  title: string
  /** The explanation. Omitted, no ⓘ is rendered at all. */
  intro?: string
  /** Accessible name for the ⓘ, e.g. "About monitors". */
  about?: string
  /** The guide topic this heading's ⓘ links on to. The sentence here is the summary; the topic
   *  is the rest of it, for anyone the summary left with a question. */
  topic?: TopicId
  titleClassName?: string
  /** Controls belonging to the heading row: create buttons, sort links. */
  children?: React.ReactNode
}) {
  const t = useT()
  const openGuide = useGuide()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      {/* Wraps rather than shrinking: a heading beside three buttons never fits a phone, and
          squeezing them onto one line truncated the heading instead. */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className={`${titleClassName ?? 'text-lg font-semibold text-gray-200'} flex items-center gap-1.5`}>
          {title}
          {intro && (
            <button
              type="button"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-label={about}
              className={`shrink-0 ${open ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'}`}
            >
              <Info size={14} />
            </button>
          )}
        </h2>
        {children}
      </div>
      {intro && open && (
        <p className="text-xs text-gray-500 max-w-lg">
          {intro}
          {topic && (
            <>
              {' '}
              <button type="button" onClick={() => openGuide(topic)} className="text-blue-400 hover:underline">
                {t('guide.readMore')} →
              </button>
            </>
          )}
        </p>
      )}
    </div>
  )
}
