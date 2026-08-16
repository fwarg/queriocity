import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, FileText, NotebookPen } from 'lucide-react'
import { NoteEditor } from './NoteEditor.tsx'
import {
  fetchResource, fetchCustomTemplates, fetchSpaces, tagFileToSpace, transformResource, untagFileFromSpace,
  type CustomTemplate, type ResourceDetail as Detail, type ResourceRef, type Space, type TransformOperation,
} from '../lib/api.ts'
import { useLang, useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import type { TranslationKey } from '@shared/i18n/index.ts'

const OPERATIONS: TransformOperation[] = ['summarize', 'keypoints', 'questions', 'outline']

/** Built-in transform labels are assembled at runtime; i18n.test.ts holds the catalogue to the list
 *  above so a fifth operation cannot ship without its label. */
const operationKey = (op: TransformOperation) => `transform.${op}` as TranslationKey

interface Props {
  id: string
  onBack: () => void
  onChanged: () => void
  /** Follow a provenance chip to another resource. */
  onOpen: (id: string) => void
}

/** What a stored resource actually contains: its summary, the spaces it feeds, and the excerpts
 *  retrieval works from. Notes are editable here; every resource can be transformed into one. */
export function ResourceDetail({ id, onBack, onChanged, onOpen }: Props) {
  const t = useT()
  const { lang } = useLang()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState(false)

  const load = useCallback(() => {
    setLoadError('')
    fetchResource(id)
      .then(setDetail)
      .catch(err => setLoadError(errorMessage(t, err, t('resource.loadFailed'))))
  }, [id, t])

  useEffect(() => { load() }, [load])

  if (loadError) return <Panel onBack={onBack}><p className="text-sm text-red-400">{loadError}</p></Panel>
  if (!detail) return <Panel onBack={onBack}><p className="text-sm text-gray-500">{t('common.loading')}</p></Panel>

  const isNote = detail.kind === 'note'
  const stamp = new Date((detail.updatedAt ?? detail.createdAt) * 1000).toLocaleDateString(lang)

  return (
    <Panel onBack={onBack}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2 min-w-0">
          {isNote
            ? <NotebookPen size={18} className="text-amber-400 shrink-0 mt-0.5" />
            : <FileText size={18} className="text-gray-500 shrink-0 mt-0.5" />}
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-200 break-words">{detail.filename}</h2>
            <p className="text-xs text-gray-500">
              {isNote ? t('note.kind') : detail.mimeType} · {stamp} · {t('resource.chunks', { count: detail.chunks.length })}
            </p>
          </div>
        </div>
        {isNote && (
          <button
            onClick={() => setEditing(true)}
            className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm shrink-0"
          >
            {t('common.edit')}
          </button>
        )}
      </div>

      <Section title={t('resource.summary')}>
        {detail.summary
          ? <p className="text-sm text-gray-300">{detail.summary}</p>
          : <p className="text-sm text-gray-500">{t('resource.noSummary')}</p>}
        {detail.topics.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {detail.topics.map(topic => (
              <span key={topic} className="px-2 py-0.5 rounded-full text-xs bg-gray-800 text-gray-400 border border-gray-700">
                {topic}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('resource.taggedTo')}>
        <SpaceTags detail={detail} onChanged={() => { load(); onChanged() }} />
      </Section>

      {detail.derivedFrom && (
        <Section title={t('resource.derivedFrom')}>
          <ResourceChip resource={detail.derivedFrom} onOpen={onOpen} />
        </Section>
      )}

      {detail.derived.length > 0 && (
        <Section title={t('resource.derivedNotes')}>
          <div className="flex flex-wrap gap-1.5">
            {detail.derived.map(note => <ResourceChip key={note.id} resource={note} onOpen={onOpen} />)}
          </div>
        </Section>
      )}

      <TransformPanel id={id} sourceTitle={detail.filename} onSaved={onChanged} />

      {isNote && detail.body && (
        <Section title={t('note.body')}>
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.body}</ReactMarkdown>
          </div>
        </Section>
      )}

      <Section title={t('resource.chunks', { count: detail.chunks.length })}>
        {detail.chunks.length === 0
          ? <p className="text-sm text-gray-500">{t('resource.noChunks')}</p>
          : (
            <>
              <p className="text-xs text-gray-500">{t('resource.chunksIntro')}</p>
              <div className="flex flex-col gap-2 mt-1">
                {detail.chunks.map((chunk, i) => (
                  <pre key={i} className="text-xs text-gray-400 bg-gray-800 rounded p-3 whitespace-pre-wrap break-words">{chunk}</pre>
                ))}
              </div>
            </>
          )}
      </Section>

      {editing && (
        <NoteEditor
          id={detail.id}
          initialTitle={detail.filename}
          initialBody={detail.body ?? ''}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); onChanged() }}
        />
      )}
    </Panel>
  )
}

function Panel({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  const t = useT()
  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 self-start">
        <ArrowLeft size={14} /> {t('resource.back')}
      </button>
      {children}
    </div>
  )
}

/** Tagging a resource to a space, from the resource rather than from the space.
 *
 *  Both directions now exist: the space panel still tags from its side, which suits setting a space
 *  up, while this suits filing a document you are already looking at — the case that made a large
 *  library tedious to organise, since it previously meant leaving the Resources view entirely. */
function SpaceTags({ detail, onChanged }: { detail: Detail; onChanged: () => void }) {
  const t = useT()
  const [spaces, setSpaces] = useState<Space[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => { fetchSpaces().then(setSpaces).catch(() => {}) }, [])

  const tagged = new Set(detail.spaces.map(s => s.id))
  const available = spaces.filter(s => !tagged.has(s.id))

  async function change(action: Promise<void>) {
    setBusy(true)
    try { await action; onChanged() } catch { /* the reload below shows the true state either way */ }
    finally { setBusy(false) }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {detail.spaces.length === 0 && <p className="text-sm text-gray-500">{t('resource.taggedToNone')}</p>}
      {detail.spaces.map(space => (
        <span key={space.id} className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-indigo-900/50 text-indigo-300 border border-indigo-800">
          {space.name}
          <button
            onClick={() => change(untagFileFromSpace(space.id, detail.id))}
            disabled={busy}
            className="text-indigo-400 hover:text-red-300 disabled:opacity-50"
            aria-label={t('resource.untagFrom', { name: space.name })}
          >
            ×
          </button>
        </span>
      ))}
      {available.length > 0 && (
        <select
          value=""
          disabled={busy}
          onChange={e => { if (e.target.value) change(tagFileToSpace(e.target.value, detail.id)) }}
          aria-label={t('resource.tagTo')}
          className="rounded bg-gray-800 border border-gray-700 px-2 py-0.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value="">+ {t('resource.tagTo')}</option>
          {available.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select>
      )}
    </div>
  )
}

/** A provenance link. The Resources view holds the open resource in state rather than in the URL,
 *  so this asks the parent to switch rather than rendering an anchor. */
function ResourceChip({ resource, onOpen }: { resource: ResourceRef; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(resource.id)}
      className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-gray-800 text-gray-300 border border-gray-700 hover:border-gray-500 hover:text-gray-100 max-w-full"
    >
      {resource.kind === 'note'
        ? <NotebookPen size={12} className="shrink-0 text-amber-400" />
        : <FileText size={12} className="shrink-0 text-gray-500" />}
      <span className="truncate">{resource.filename}</span>
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</h3>
      {children}
    </div>
  )
}

/** Runs a prompt over the resource and offers the result for saving. The result is held in state
 *  rather than written straight to a note: a transform that came back wrong should cost nothing. */
function TransformPanel({ id, sourceTitle, onSaved }: { id: string; sourceTitle: string; onSaved: () => void }) {
  const t = useT()
  const [templates, setTemplates] = useState<CustomTemplate[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ label: string; content: string } | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchCustomTemplates().then(setTemplates).catch(() => {}) }, [])

  async function run(target: { operation: TransformOperation } | { templateId: string }, label: string) {
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const { content } = await transformResource(id, target)
      setResult({ label, content })
    } catch (err: unknown) {
      setError(errorMessage(t, err, t('resource.transformFailed')))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Section title={t('resource.transform')}>
      <p className="text-xs text-gray-500">{t('resource.transformIntro')}</p>
      <div className="flex flex-wrap gap-2 mt-1">
        {OPERATIONS.map(op => (
          <button
            key={op}
            disabled={running}
            onClick={() => run({ operation: op }, t(operationKey(op)))}
            className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm"
          >
            {t(operationKey(op))}
          </button>
        ))}
        {templates.length > 0 && (
          <select
            disabled={running}
            value=""
            onChange={e => {
              const template = templates.find(tpl => tpl.id === e.target.value)
              if (template) run({ templateId: template.id }, template.name)
            }}
            aria-label={t('resource.useTemplate')}
            className="rounded bg-gray-700 border border-gray-600 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          >
            <option value="">{t('resource.useTemplate')}</option>
            {templates.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
          </select>
        )}
      </div>

      {running && <p className="text-xs text-gray-400 animate-pulse mt-1">{t('resource.transformRunning')}</p>}
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}

      {result && (
        <div className="flex flex-col gap-2 mt-2 p-3 rounded-lg bg-gray-800 border border-gray-700">
          <div className="prose prose-invert prose-sm max-w-none max-h-80 overflow-y-auto">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.content}</ReactMarkdown>
          </div>
          <div className="flex justify-end">
            <button onClick={() => setSaving(true)} className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium">
              {t('resource.saveAsNote')}
            </button>
          </div>
        </div>
      )}

      {saving && result && (
        <NoteEditor
          // The title carries the source too, because it is the label every search hit and citation
          // shows — "Open questions" on its own says nothing about which document they concern.
          initialTitle={`${result.label} — ${sourceTitle}`}
          // The provenance line is part of the text, not just metadata: a note is often read as a
          // retrieved excerpt with everything around it stripped away, and the stored link below
          // cannot travel that far. Editable like the rest, since it is only a first line.
          initialBody={`> ${t('resource.derivedFromLine', { operation: result.label, source: sourceTitle })}\n\n${result.content}`}
          derivedFrom={id}
          onClose={() => setSaving(false)}
          onSaved={() => { setSaving(false); setResult(null); onSaved() }}
        />
      )}
    </Section>
  )
}
