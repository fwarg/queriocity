import { useState } from 'react'
import type { Resource } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { byTypeThenTitle, EMPTY_FILTER, matchesFilter, ResourceTypeIcon, TypeChips, type ResourceType } from './ResourceFilters.tsx'

/** The resources a space or collection can still take, narrowed by text and type. Stays open after
 *  each pick, so several can be tagged in a row; the parent drops each tagged one from `resources`. */
export function TagResourcePicker({ resources, onTag }: { resources: Resource[]; onTag: (id: string) => void }) {
  const t = useT()
  const [text, setText] = useState('')
  const [type, setType] = useState<'' | ResourceType>('')
  const shown = resources.filter(r => matchesFilter(r, { ...EMPTY_FILTER, text, type })).sort(byTypeThenTitle)
  return (
    <div className="mt-2 flex flex-col gap-1.5 border border-gray-700 rounded p-2 bg-gray-900">
      <input
        type="search"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={t('files.tagPickerFilter')}
        aria-label={t('files.tagPickerFilter')}
        className="w-full text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-100 focus:outline-none focus:border-blue-500"
      />
      <TypeChips resources={resources} type={type} onChange={setType} />
      <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
        {shown.map(f => (
          <button
            key={f.id}
            onClick={() => onTag(f.id)}
            // shrink-0: in a height-capped column, rows would otherwise shrink until they overlap.
            className="shrink-0 flex items-center gap-1.5 text-left text-xs text-gray-300 hover:text-gray-50 px-1 py-0.5 hover:bg-gray-800 rounded min-w-0"
          >
            <ResourceTypeIcon resource={f} size={12} />
            <span className="truncate">{f.filename}</span>
          </button>
        ))}
        {!shown.length && <p className="text-xs text-gray-600">{t('files.filterShowing', { count: 0 })}</p>}
      </div>
    </div>
  )
}
