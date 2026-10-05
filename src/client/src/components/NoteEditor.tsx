import { useRef, useState } from 'react'
import { Link } from 'lucide-react'
import { Modal } from './Modal.tsx'
import { LinkPicker } from './LinkPicker.tsx'
import { NoteMarkdown } from './NoteMarkdown.tsx'
import { TagEditor } from './TagEditor.tsx'
import { createNote, updateNote } from '../lib/api.ts'
import { wikilinkFor } from '../lib/wikilinks.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'

interface Props {
  /** Omitted for a new note; given when editing an existing one. */
  id?: string
  initialTitle?: string
  initialBody?: string
  initialTags?: string[]
  /** The resource a transform produced this note from. Recorded once, at creation. */
  derivedFrom?: string
  /** The chat and answer this note is saved from. Recorded once, at creation. */
  originSessionId?: string
  originMessageId?: string
  onClose: () => void
  onSaved: (id: string) => void
}

/** The one place a note is written, used for a blank note, an edit, and an answer saved from a chat. */
export function NoteEditor({ id, initialTitle = '', initialBody = '', initialTags = [], derivedFrom, originSessionId, originMessageId, onClose, onSaved }: Props) {
  const t = useT()
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState(initialBody)
  const [tags, setTags] = useState(initialTags)
  const linking = useWikilinkInsert(body, setBody)
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
        await updateNote(id, { title: title.trim(), body: body.trim(), tags })
        onSaved(id)
      } else {
        const created = await createNote(title.trim(), body.trim(), { derivedFrom, originSessionId, originMessageId, tags })
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
          <div className="flex items-center gap-3">
            {!preview && (
              <button type="button" onClick={linking.open} className="flex items-center gap-1 py-1 text-gray-400 hover:text-gray-200">
                <Link size={12} /> {t('links.insert')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setPreview(p => !p)}
              className="py-1 text-gray-400 hover:text-gray-200"
            >
              {preview ? t('note.write') : t('note.preview')}
            </button>
          </div>
        </div>
        {preview ? (
          <div className="prose prose-invert prose-sm max-w-none min-h-60 bg-gray-800 border border-gray-700 rounded px-3 py-2 overflow-y-auto">
            {body.trim()
              ? <NoteMarkdown body={body} />
              : <p className="text-gray-500 text-sm">{t('note.emptyBody')}</p>}
          </div>
        ) : (
          <textarea
            ref={linking.textareaRef}
            value={body}
            onChange={linking.onChange}
            maxLength={100_000}
            rows={14}
            placeholder={t('note.bodyPlaceholder')}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 font-mono resize-y focus:outline-none focus:border-blue-500"
          />
        )}
      </div>

      <div className="flex flex-col gap-1 text-xs text-gray-400">
        {t('tags.title')}
        <TagEditor tags={tags} onChange={setTags} />
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

      {linking.picking && <LinkPicker excludeId={id} onPick={linking.insert} onClose={linking.close} />}
    </Modal>
  )
}

/** Inserting `[[Title]]` at the cursor, from the link button or by typing `[[`. Typed brackets are
 *  replaced by the picked link, and kept if the picker is dismissed. */
function useWikilinkInsert(body: string, setBody: (body: string) => void) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [picking, setPicking] = useState(false)
  // Where the link goes, and how many typed characters (a `[[`) it replaces.
  const target = useRef({ at: 0, replace: 0 })

  return {
    textareaRef,
    picking,
    open: () => {
      const at = textareaRef.current?.selectionStart ?? body.length
      target.current = { at, replace: 0 }
      setPicking(true)
    },
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      const at = e.target.selectionStart
      setBody(value)
      if (value.length > body.length && value.slice(at - 2, at) === '[[') {
        target.current = { at: at - 2, replace: 2 }
        setPicking(true)
      }
    },
    insert: (title: string) => {
      const { at, replace } = target.current
      const link = wikilinkFor(title)
      setBody(body.slice(0, at) + link + body.slice(at + replace))
      setPicking(false)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) { el.focus(); el.setSelectionRange(at + link.length, at + link.length) }
      })
    },
    close: () => setPicking(false),
  }
}
