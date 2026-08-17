import { useState } from 'react'
import { Lock, Unlock, MessagesSquare, Library } from 'lucide-react'
import type { Space, SpaceKind } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

interface Props {
  spaces: Space[]
  onOpen: (id: string) => void
  onCreate: (name: string, kind: SpaceKind) => void
  onToggleLock: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
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

  const sections: Array<{ kind: SpaceKind; title: string; empty: string; add: string }> = [
    { kind: 'space', title: t('nav.spaces'), empty: t('space.none'), add: t('space.new') },
    { kind: 'collection', title: t('collection.plural'), empty: t('collection.none'), add: t('collection.new') },
  ]

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-6">
      {sections.map(section => {
        const rows = spaces.filter(s => s.kind === section.kind)
        return (
          <div key={section.kind} className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-200">{section.title}</h2>
              {creating !== section.kind && (
                <button
                  onClick={() => { setCreating(section.kind); setDraft('') }}
                  className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium whitespace-nowrap"
                >
                  + {section.add}
                </button>
              )}
            </div>

            {section.kind === 'collection' && (
              <p className="text-xs text-gray-500 max-w-lg -mt-1">{t('collection.intro')}</p>
            )}

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
              <p className="text-gray-500 text-sm">{section.empty}</p>
            ) : rows.map(sp => (
              <div key={sp.id} className="flex items-center gap-2 group">
                <button
                  onClick={() => onOpen(sp.id)}
                  className="flex-1 text-left px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-100 flex items-center gap-2 min-w-0"
                >
                  {sp.kind === 'collection'
                    ? <Library size={14} className="shrink-0 text-amber-400" />
                    : <MessagesSquare size={14} className="shrink-0 text-indigo-400" />}
                  {sp.offline && <Lock size={12} className="shrink-0 -ml-0.5 text-amber-400" aria-label={t('space.locked')} />}
                  <span className="truncate">{sp.name}</span>
                  {/* A collection is measured by what it holds, a space by what happens in it. */}
                  <span className="ml-auto pl-2 text-xs text-gray-500 shrink-0">
                    {sp.kind === 'collection'
                      ? t('collection.holdsResources', { count: sp.resourceCount })
                      : `${t('space.holdsChats', { count: sp.chatCount })}${sp.memoryCount > 0 ? ` · ${t('space.holdsMemories', { count: sp.memoryCount })}` : ''}`}
                  </span>
                </button>
                {/* Locking denies a chat web access, so it is offered only where there are chats. */}
                {sp.kind === 'space' && (
                  <button
                    onClick={() => onToggleLock(sp.id)}
                    className={`px-2 py-2 shrink-0 transition-opacity ${sp.offline ? 'text-amber-400 hover:text-amber-300' : 'text-gray-600 hover:text-gray-300 md:opacity-0 md:group-hover:opacity-100'}`}
                    title={t(sp.offline ? 'space.lockedTitle' : 'space.lockTitle')}
                    aria-label={sp.offline ? t('space.unlockNamed', { name: sp.name }) : t('space.lockNamed', { name: sp.name })}
                  >
                    {sp.offline ? <Lock size={14} /> : <Unlock size={14} />}
                  </button>
                )}
                <button
                  onClick={e => onDelete(sp.id, e)}
                  className="px-2 py-2 text-gray-600 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
                  aria-label={t('space.deleteNamed', { name: sp.name })}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
