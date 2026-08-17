/** The pieces every list view repeats, in one place.
 *
 *  Each of these was retyped per view and drifted: rows shaded differently, delete buttons revealed
 *  by three different rules, three empty-state styles. The point of a primitive here is less reuse
 *  than a single answer — a new view inherits the conventions instead of inventing them again. */

const TONES = {
  default: 'text-gray-600 hover:text-gray-300',
  danger: 'text-gray-600 hover:text-red-400',
  /** Already on, and saying so — a locked space, a pinned memory. Never hidden. */
  active: 'text-amber-400 hover:text-amber-300',
} as const

/** The primary action of a view or panel. */
export const PRIMARY_BTN =
  'px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium whitespace-nowrap transition-colors'

/** An action inside a ListRow.
 *
 *  Hidden until hover from `md` up and always visible below it: a phone has no hover, and an
 *  `opacity-0` button there is invisible yet still tappable — you delete blind. Owning the rule
 *  here is what keeps that from being re-decided per call site. Stops the row's own click too. */
export function RowAction({ icon, label, onClick, tone = 'default', persistent = false }: {
  icon: React.ReactNode
  /** Required: it is both the tooltip and the only name a screen reader has for an icon. */
  label: string
  onClick: () => void
  tone?: keyof typeof TONES
  /** Keep it visible at every size — for state a row should show at rest, not on hover. */
  persistent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onClick() }}
      aria-label={label}
      title={label}
      className={`p-1.5 rounded shrink-0 transition-opacity ${TONES[tone]} ${persistent ? '' : 'md:opacity-0 md:group-hover:opacity-100'}`}
    >
      {icon}
    </button>
  )
}

/** A list row: one shaded card, clickable, with its actions inside it.
 *
 *  `role`/`tabIndex` rather than a `<button>` because the row contains buttons and nesting them is
 *  invalid HTML — which is why the resource list could not be opened from the keyboard at all. */
export function ListRow({ onClick, align = 'start', children }: {
  onClick?: () => void
  align?: 'start' | 'center'
  children: React.ReactNode
}) {
  return (
    <div
      onClick={onClick}
      onKeyDown={onClick && (e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() }
      })}
      role={onClick && 'button'}
      tabIndex={onClick && 0}
      className={`flex ${align === 'center' ? 'items-center' : 'items-start'} gap-3 group px-4 py-3 rounded-lg bg-gray-800 ${
        onClick ? 'hover:bg-gray-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500' : ''
      }`}
    >
      {children}
    </div>
  )
}

/** "Nothing here yet" — `dense` for a nested list inside a row, where the page style shouts. */
export function EmptyState({ dense = false, children }: { dense?: boolean; children: React.ReactNode }) {
  return <p className={dense ? 'text-xs text-gray-600' : 'text-sm text-gray-500'}>{children}</p>
}
