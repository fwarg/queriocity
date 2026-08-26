import { useRef, useState } from 'react'
import { FileText, NotebookPen, Trash2, X } from 'lucide-react'
import { NoteEditor } from './NoteEditor.tsx'
import { SectionHeader } from './SectionHeader.tsx'
import { useConfirm } from './confirm.tsx'
import { EmptyState, ListRow, PRIMARY_BTN, RowAction } from './ui.tsx'
import { ResourceDetail } from './ResourceDetail.tsx'
import { EMPTY_FILTER, isFiltered, matchesFilter, ResourceFilters, toggleSpace, toggleTopic, type ResourceFilter } from './ResourceFilters.tsx'
import { deleteFile, ingestUrl, uploadFile, type Resource } from '../lib/api.ts'
import { useLang, useT } from '../lib/i18n.tsx'

/** Above this many resources the filter bar is always shown; below it, only while filtering. */
const FILTER_BAR_THRESHOLD = 8

const CHIP_TONES = {
  space: {
    idle: 'bg-indigo-950 text-indigo-300 border-indigo-900 hover:border-indigo-700',
    active: 'bg-indigo-700 text-white border-indigo-500',
  },
  topic: {
    idle: 'bg-gray-900 text-gray-400 border-gray-700 hover:border-gray-500',
    active: 'bg-gray-600 text-white border-gray-400',
  },
} as const

/** A chip that toggles a filter. Stops the row's own click, which opens the resource. */
function Chip({ tone, active, onClick, children }: {
  tone: keyof typeof CHIP_TONES
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const t = useT()
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      aria-pressed={active}
      title={t(active ? 'files.filterRemove' : 'files.filterBy')}
      className={`px-1.5 py-0.5 rounded-full text-[11px] border transition-colors ${CHIP_TONES[tone][active ? 'active' : 'idle']}`}
    >
      {children}{active && <X size={10} className="inline ml-0.5 -mt-0.5" />}
    </button>
  )
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  resources: Resource[]
  /** Reload the list — the parent owns it, because the space panel tags from the same set. */
  onChanged: () => void
  /** Which resource's detail panel is open. Controlled by the parent rather than local state, so a
   *  citation elsewhere in the app (a chat's [F1]/[C1] resource reference) can open one directly by
   *  switching to this view with an id already set. */
  openId: string | null
  onOpenIdChange: (id: string | null) => void
}

/** The resource library: uploaded files, ingested URLs and notes, in one list.
 *
 *  Lives here rather than inline in App.tsx because it now owns a detail panel and two editors;
 *  the list state stays with the parent, which needs the same resources for space tagging. */
export function ResourcesView({ resources, onChanged, openId, onOpenIdChange }: Props) {
  const t = useT()
  const confirm = useConfirm()
  const { lang } = useLang()
  const [writingNote, setWritingNote] = useState(false)
  const [filter, setFilter] = useState<ResourceFilter>(EMPTY_FILTER)

  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'ok' | 'error'>('idle')
  const [uploadMsg, setUploadMsg] = useState('')

  const [urlOpen, setUrlOpen] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [urlStatus, setUrlStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [urlError, setUrlError] = useState('')

  const shown = resources.filter(r => matchesFilter(r, filter))

  if (openId) {
    return <ResourceDetail id={openId} onBack={() => onOpenIdChange(null)} onChanged={onChanged} onOpen={onOpenIdChange} />
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadStatus('uploading')
    setUploadMsg(t('files.uploading', { name: file.name }))
    try {
      await uploadFile(file)
      setUploadStatus('ok')
      setUploadMsg(t('files.uploaded', { name: file.name }))
      onChanged()
      setTimeout(() => setUploadStatus('idle'), 3000)
    } catch (err: unknown) {
      setUploadStatus('error')
      setUploadMsg(err instanceof Error ? err.message : t('files.uploadFailed'))
      setTimeout(() => setUploadStatus('idle'), 4000)
    } finally {
      e.target.value = ''
    }
  }

  async function handleUrlIngest() {
    if (!urlValue.trim()) return
    setUrlStatus('loading')
    setUrlError('')
    try {
      await ingestUrl(urlValue.trim())
      onChanged()
      setUrlOpen(false)
      setUrlValue('')
      setUrlStatus('idle')
    } catch (err: unknown) {
      setUrlStatus('error')
      setUrlError(err instanceof Error ? err.message : t('files.ingestFailed'))
    }
  }

  async function handleDelete(resource: Resource) {
    if (!await confirm({
      message: t('files.deleteConfirm', { name: resource.filename }),
      confirmLabel: t('common.delete'),
      danger: true,
    })) return
    deleteFile(resource.id).then(onChanged).catch(() => {})
  }

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-4">
      <SectionHeader title={t('nav.resources')} intro={t('files.intro')} about={t('files.aboutTitle')} topic="resources">
        <div className="flex flex-col gap-1 items-end">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setWritingNote(true)}
              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
            >
              + {t('note.new')}
            </button>
            <button
              onClick={() => { setUrlOpen(o => !o); setUrlValue(''); setUrlStatus('idle') }}
              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
            >
              + {t('files.addUrl')}
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploadStatus === 'uploading'}
              className={PRIMARY_BTN}
            >
              {uploadStatus === 'uploading' ? t('files.uploadingShort') : `+ ${t('files.upload')}`}
            </button>
          </div>
          {uploadStatus !== 'idle' && (
            <span className={`text-xs ${uploadStatus === 'error' ? 'text-red-400' : 'text-green-400'}`}>
              {uploadMsg}
            </span>
          )}
          <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
        </div>
      </SectionHeader>

      {urlOpen && (
        <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-gray-800 border border-gray-700">
          <div className="flex gap-2">
            <input
              type="url"
              value={urlValue}
              onChange={e => setUrlValue(e.target.value)}
              placeholder="https://…"
              className="flex-1 text-sm bg-gray-900 border border-gray-700 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
              onKeyDown={async e => { if (e.key === 'Enter') { e.preventDefault(); await handleUrlIngest() } }}
              disabled={urlStatus === 'loading'}
              autoFocus
            />
            <button
              onClick={handleUrlIngest}
              disabled={!urlValue.trim() || urlStatus === 'loading'}
              className={PRIMARY_BTN}
            >
              {urlStatus === 'loading' ? t('files.fetching') : t('files.fetchAndAdd')}
            </button>
          </div>
          {urlStatus === 'error' && <p className="text-xs text-red-400">{urlError}</p>}
        </div>
      )}

      {resources.length === 0 && !urlOpen ? (
        <EmptyState>{t('files.none')}</EmptyState>
      ) : (
        <>
          {/* Worth its space once scrolling stops being enough — but always while a filter is
              active, whatever the count. A row's chips can set one at any size, and hiding the bar
              then left the list narrowed with nothing naming the filter and no way to clear it. */}
          {(resources.length > FILTER_BAR_THRESHOLD || isFiltered(filter)) && (
            <ResourceFilters resources={resources} filter={filter} onChange={setFilter} shown={shown.length} />
          )}
          {shown.length === 0 ? (
            <EmptyState>{t('files.filterNone')}</EmptyState>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map(r => (
                <ListRow key={r.id} onClick={() => onOpenIdChange(r.id)}>
                  {r.kind === 'note'
                    ? <NotebookPen size={16} className="text-amber-400 shrink-0 mt-0.5" />
                    : <FileText size={16} className="text-gray-500 shrink-0 mt-0.5" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-100 truncate">{r.filename}</div>
                    {r.summary && <div className="text-xs text-gray-400 mt-0.5 line-clamp-2">{r.summary}</div>}
                    <div className="text-xs text-gray-500 mt-0.5">
                      {r.kind === 'note' ? t('note.kind') : r.mimeType} · {formatSize(r.size)} · {new Date((r.updatedAt ?? r.createdAt) * 1000).toLocaleDateString(lang)}
                    </div>
                    {/* Space and topic chips both narrow the list rather than opening the resource,
                        so they stop the row's own click — two grouping axes, one crossing projects
                        and one following them. Each toggles: the chip that applied a filter is the
                        obvious place to look for the way back out of it, and shows itself selected
                        so the filter is visible on every row it matched, not only in the bar. */}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {r.spaces.map(space => (
                        <Chip
                          key={space.id}
                          tone="space"
                          active={filter.space === space.id}
                          onClick={() => setFilter(f => toggleSpace(f, space.id))}
                        >
                          {space.name}
                        </Chip>
                      ))}
                      {r.topics.map(topic => (
                        <Chip
                          key={topic}
                          tone="topic"
                          active={filter.topic === topic}
                          onClick={() => setFilter(f => toggleTopic(f, topic))}
                        >
                          {topic}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <RowAction
                    icon={<Trash2 size={14} />}
                    tone="danger"
                    label={t('files.deleteNamed', { name: r.filename })}
                    onClick={() => handleDelete(r)}
                  />
                </ListRow>
              ))}
            </div>
          )}
        </>
      )}

      {writingNote && (
        <NoteEditor
          onClose={() => setWritingNote(false)}
          onSaved={() => { setWritingNote(false); onChanged() }}
        />
      )}
    </div>
  )
}
