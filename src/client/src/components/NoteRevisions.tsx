import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { fetchNoteRevisions, restoreNoteRevision, type NoteRevision } from '../lib/api.ts'
import { useLang, useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { useConfirm } from './confirm.tsx'
import { HUMAN_AUTHOR } from '@shared/note-trust.ts'

/** A note's earlier versions — what the model replaced when it reworked its draft — each restorable.
 *  Folded away like the excerpts, and absent until a version exists. `version` reloads the list
 *  after the note changes. */
export function NoteRevisions({ noteId, version, onRestored }: { noteId: string; version: number | null; onRestored: () => void }) {
  const t = useT()
  const { lang } = useLang()
  const confirm = useConfirm()
  const [revisions, setRevisions] = useState<NoteRevision[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    fetchNoteRevisions(noteId).then(r => { if (current) setRevisions(r) }).catch(() => {})
    return () => { current = false }
  }, [noteId, version])

  async function restore(rev: NoteRevision) {
    if (!await confirm({ message: t('revisions.restoreConfirm'), confirmLabel: t('revisions.restore') })) return
    setError('')
    try {
      await restoreNoteRevision(noteId, rev.id)
      onRestored()
    } catch (e) {
      setError(errorMessage(t, e, t('revisions.failed')))
    }
  }

  if (!revisions.length) return null
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs font-medium uppercase tracking-wide text-gray-500 hover:text-gray-300 flex items-center gap-1">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
        {t('revisions.title', { count: revisions.length })}
      </summary>
      <p className="text-xs text-gray-500 mt-1.5">{t('revisions.intro')}</p>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      <div className="flex flex-col gap-2 mt-1">
        {revisions.map(rev => (
          <div key={rev.id} className="bg-gray-800 rounded p-3 flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-gray-500 truncate">
                {t('revisions.by', { actor: rev.actor === HUMAN_AUTHOR ? t('revisions.you') : rev.actor, date: new Date(rev.createdAt * 1000).toLocaleString(lang) })} · {rev.title}
              </p>
              <button onClick={() => restore(rev)} className="shrink-0 px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600">{t('revisions.restore')}</button>
            </div>
            <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{rev.body}</pre>
          </div>
        ))}
      </div>
    </details>
  )
}
