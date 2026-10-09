import { useEffect, useState } from 'react'
import { FileText, NotebookPen } from 'lucide-react'
import { Modal } from './Modal.tsx'
import { fetchFiles, type Resource } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

const MAX_SHOWN = 50

/** Pick a resource to link to by title. A list to tap rather than an inline completion popup,
 *  which on a phone would sit under the keyboard. */
export function LinkPicker({ excludeId, onPick, onClose }: {
  excludeId?: string
  onPick: (title: string) => void
  onClose: () => void
}) {
  const t = useT()
  const [resources, setResources] = useState<Resource[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => { fetchFiles().then(setResources).catch(() => setResources([])) }, [])

  const q = query.trim().toLowerCase()
  const shown = (resources ?? [])
    .filter(r => r.id !== excludeId && (!q || r.filename.toLowerCase().includes(q)))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, MAX_SHOWN)

  return (
    <Modal title={t('links.pickerTitle')} onClose={onClose}>
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('links.search')}
        aria-label={t('links.search')}
        className="text-sm bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-blue-500"
      />
      {resources === null
        ? <p className="text-sm text-gray-500">{t('common.loading')}</p>
        : shown.length === 0
          ? <p className="text-sm text-gray-500">{t('links.noMatch')}</p>
          : (
            <div className="flex flex-col gap-1">
              {shown.map(r => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onPick(r.filename)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded text-left text-sm text-gray-200 bg-gray-800 hover:bg-gray-700"
                >
                  {r.kind === 'note'
                    ? <NotebookPen size={14} className="shrink-0 text-amber-400" />
                    : <FileText size={14} className="shrink-0 text-gray-500" />}
                  <span className="truncate">{r.filename}</span>
                </button>
              ))}
            </div>
          )}
    </Modal>
  )
}
