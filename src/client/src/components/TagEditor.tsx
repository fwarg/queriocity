import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { normaliseTag, tagAncestry } from '@shared/tags.ts'
import { fetchTags } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'

const MAX_COMPLETIONS = 6

interface Props {
  tags: string[]
  /** The small model's topics not yet adopted, offered as one-tap additions. */
  suggestions?: string[]
  /** Called with the full new list. May save straight away (detail view) or just hold it (editor). */
  onChange: (tags: string[]) => void | Promise<void>
}

/** Tag chips with an add field, completion from the user's existing tags, and suggestions.
 *
 *  Completions are chips under the field rather than a dropdown over it: on a phone the keyboard
 *  covers half the screen, and a floating list there is where taps go astray. */
export function TagEditor({ tags, suggestions = [], onChange }: Props) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [known, setKnown] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchTags()
      .then(list => setKnown([...new Set(list.flatMap(tag => tagAncestry(tag.path)))].sort()))
      .catch(() => {})
  }, [])

  async function apply(next: string[]) {
    setBusy(true)
    setError('')
    try { await onChange([...new Set(next)].sort()) } catch (err: unknown) {
      setError(errorMessage(t, err, t('tags.saveFailed')))
    } finally { setBusy(false) }
  }

  function add(raw: string) {
    const tag = normaliseTag(raw)
    setDraft('')
    if (tag && !tags.includes(tag)) apply([...tags, tag])
  }

  const query = normaliseTag(draft)
  const completions = query
    ? known.filter(k => k.includes(query) && !tags.includes(k)).slice(0, MAX_COMPLETIONS)
    : []
  const offered = suggestions.filter(s => !tags.includes(s))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 && <span className="text-sm text-gray-500">{t('tags.none')}</span>}
        {tags.map(tag => (
          <span key={tag} className="flex items-center gap-0.5 pl-2 rounded-full text-xs bg-emerald-950 text-emerald-300 border border-emerald-800">
            #{tag}
            <button
              type="button"
              disabled={busy}
              onClick={() => apply(tags.filter(x => x !== tag))}
              className="p-1.5 text-emerald-500 hover:text-red-300 disabled:opacity-50"
              aria-label={t('tags.remove', { tag })}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft) }
          }}
          placeholder={t('tags.addPlaceholder')}
          aria-label={t('tags.addPlaceholder')}
          autoCapitalize="none"
          autoCorrect="off"
          className="flex-1 min-w-0 text-sm bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-gray-100 focus:outline-none focus:border-blue-500"
        />
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={!query || busy}
          className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm"
        >
          {t('tags.add')}
        </button>
      </div>

      {(completions.length > 0 || offered.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {completions.map(tag => <AddChip key={`c-${tag}`} tag={tag} onAdd={add} />)}
          {completions.length === 0 && offered.length > 0 && <span className="text-xs text-gray-500">{t('tags.suggested')}:</span>}
          {completions.length === 0 && offered.map(tag => <AddChip key={`s-${tag}`} tag={tag} onAdd={add} dashed />)}
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

function AddChip({ tag, onAdd, dashed = false }: { tag: string; onAdd: (tag: string) => void; dashed?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onAdd(tag)}
      className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs text-gray-300 border hover:text-emerald-300 hover:border-emerald-700 ${dashed ? 'border-dashed border-gray-600' : 'border-gray-700 bg-gray-800'}`}
    >
      <Plus size={11} />#{tag}
    </button>
  )
}
