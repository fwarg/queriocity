import { LANGUAGES, type Lang } from '@shared/i18n/index.ts'
import { useT } from '../lib/i18n.tsx'

/** The language picker, rendered from LANGUAGES so a new catalog needs no edit here.
 *
 *  A native <select> rather than a custom dropdown: it is the one control that already works with
 *  a keyboard, a screen reader and a phone's native picker, and the list is short enough that the
 *  flag + name is all the affordance it needs. */
export function LanguageSelect({ value, onChange, className = '' }: {
  value: Lang
  onChange: (lang: Lang) => void
  className?: string
}) {
  const t = useT()
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as Lang)}
      aria-label={t('settings.language')}
      className={`rounded bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500 ${className}`}
    >
      {LANGUAGES.map(l => (
        <option key={l.code} value={l.code}>{l.flag} {l.label}</option>
      ))}
    </select>
  )
}
