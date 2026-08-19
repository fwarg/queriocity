import { useState } from 'react'
import { Lock, Unlock, MessagesSquare, Library, Trash2 } from 'lucide-react'
import { SectionHeader } from './SectionHeader.tsx'
import type { TopicId } from '@shared/guide/index.ts'
import { EmptyState, ListRow, RowAction } from './ui.tsx'
import type { Space, SpaceKind } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

interface Props {
  spaces: Space[]
  onOpen: (id: string) => void
  onCreate: (name: string, kind: SpaceKind) => void
  onToggleLock: (id: string) => void
  onDelete: (id: string) => void
}

/** Both kinds of grouping, in two labelled sections.
 *
 *  One list rather than a separate nav item, because they are one concept: a collection is a space
 *  that holds resources instead of chats, and can be promoted into one. Grouping them keeps that
 *  legible and leaves the Resources filter chips — which already show both — with one thing to mean. */
export function SpacesView({ spaces, onOpen, onCreate, onToggleLock, onDelete }: Props) {
  const t = useT()
  const [creating, setCreating] = useState<SpaceKind | null>(null)
  const [draft, setDraft] = useState('')

  function submit() {
    const name = draft.trim()
    if (name && creating) onCreate(name, creating)
    setDraft('')
    setCreating(null)
  }

  /** `intro` is optional and folded behind the ⓘ beside the heading: it is onboarding, and left
   *  standing it took most of a phone screen before the first row. */
  const sections: Array<{ kind: SpaceKind; title: string; empty: string; add: string; intro?: string; about?: string; topic?: TopicId }> = [
    {
      kind: 'space', title: t('nav.spaces'), empty: t('space.none'), add: t('space.new'),
      intro: t('space.intro'), about: t('space.aboutTitle'), topic: 'spaces',
    },
    {
      kind: 'collection', title: t('collection.plural'), empty: t('collection.none'), add: t('collection.new'),
      intro: t('collection.intro'), about: t('collection.aboutTitle'), topic: 'collections',
    },
  ]

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-6">
      {sections.map(section => {
        const rows = spaces.filter(s => s.kind === section.kind)
        return (
          <div key={section.kind} className="flex flex-col gap-3">
            <SectionHeader title={section.title} intro={section.intro} about={section.about} topic={section.topic}>
              {creating !== section.kind && (
                <button
                  onClick={() => { setCreating(section.kind); setDraft('') }}
                  className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium whitespace-nowrap"
                >
                  + {section.add}
                </button>
              )}
            </SectionHeader>

            {creating === section.kind && (
              <input
                autoFocus
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setCreating(null); setDraft('') } }}
                onBlur={submit}
                placeholder={t(section.kind === 'collection' ? 'collection.namePlaceholder' : 'space.namePlaceholder')}
                className="px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
              />
            )}

            {rows.length === 0 && creating !== section.kind ? (
              <EmptyState>{section.empty}</EmptyState>
            ) : rows.map(sp => (
              <ListRow key={sp.id} align="center" onClick={() => onOpen(sp.id)}>
                {sp.kind === 'collection'
                  ? <Library size={14} className="shrink-0 text-amber-400" />
                  : <MessagesSquare size={14} className="shrink-0 text-indigo-400" />}
                {sp.offline && <Lock size={12} className="shrink-0 -ml-1.5 text-amber-400" aria-label={t('space.locked')} />}
                <span className="truncate text-sm text-gray-100">{sp.name}</span>
                {/* A collection is measured by what it holds, a space by what happens in it. */}
                <span className="ml-auto pl-2 text-xs text-gray-500 shrink-0">
                  {sp.kind === 'collection'
                    ? t('collection.holdsResources', { count: sp.resourceCount })
                    : `${t('space.holdsChats', { count: sp.chatCount })}${sp.memoryCount > 0 ? ` · ${t('space.holdsMemories', { count: sp.memoryCount })}` : ''}`}
                </span>
                {/* Locking denies a chat web access, so it is offered only where there are chats.
                    Persistent once on: a lock is state the row should state at rest, not on hover. */}
                {sp.kind === 'space' && (
                  <RowAction
                    icon={sp.offline ? <Lock size={14} /> : <Unlock size={14} />}
                    tone={sp.offline ? 'active' : 'default'}
                    persistent={sp.offline}
                    label={sp.offline ? t('space.unlockNamed', { name: sp.name }) : t('space.lockNamed', { name: sp.name })}
                    onClick={() => onToggleLock(sp.id)}
                  />
                )}
                <RowAction
                  icon={<Trash2 size={14} />}
                  tone="danger"
                  label={t('space.deleteNamed', { name: sp.name })}
                  onClick={() => onDelete(sp.id)}
                />
              </ListRow>
            ))}
          </div>
        )
      })}
    </div>
  )
}
