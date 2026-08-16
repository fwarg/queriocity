import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Modal } from './Modal.tsx'
import { createNote, updateNote } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'

interface Props {
  /** Omitted for a new note; given when editing an existing one. */
  id?: string
  initialTitle?: string
  initialBody?: string
  onClose: () => void
  onSaved: (id: string) => void
}

/** The one place a note is written, used for a blank note, an edit, and an answer saved from a chat.
 *
 *  Preview shares the markdown renderer with the message list but not its plugins: a note is prose,
 *  and citation links, maths and SVG blocks belong to an answer rather than to something typed. */
export function NoteEditor({ id, initialTitle = '', initialBody = '', onClose, onSaved }: Props) {
  const t = useT()
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState(initialBody)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const canSave = title.trim().length > 0 && body.trim().length > 0 && !saving

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      if (id) {
        await updateNote(id, { title: title.trim(), body: body.trim() })
        onSaved(id)
      } else {
        const created = await createNote(title.trim(), body.trim())
        onSaved(created.id)
      }
    } catch (err: unknown) {
      setError(errorMessage(t, err, t('note.saveFailed')))
      setSaving(false)
    }
  }

  return (
    <Modal title={id ? t('note.edit') : t('note.newTitle')} onClose={onClose} maxWidth="max-w-2xl">
      <label className="flex flex-col gap-1 text-xs text-gray-400">
        {t('note.title')}
        <input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={200}
          placeholder={t('note.titlePlaceholder')}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        />
      </label>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span>{t('note.body')}</span>
          <button
            type="button"
            onClick={() => setPreview(p => !p)}
            className="text-gray-400 hover:text-gray-200"
          >
            {preview ? t('note.write') : t('note.preview')}
          </button>
        </div>
        {preview ? (
          <div className="prose prose-invert prose-sm max-w-none min-h-60 bg-gray-800 border border-gray-700 rounded px-3 py-2 overflow-y-auto">
            {body.trim()
              ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
              : <p className="text-gray-500 text-sm">{t('note.emptyBody')}</p>}
          </div>
        ) : (
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            maxLength={100_000}
            rows={14}
            placeholder={t('note.bodyPlaceholder')}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 font-mono resize-y focus:outline-none focus:border-blue-500"
          />
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm">
          {t('common.cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Modal>
  )
}
