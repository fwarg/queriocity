/** Tabs across the top of a view, e.g. Chats | Monitors. Scrolls sideways rather than wrapping on
 *  a narrow phone. */
export function ViewTabs<T extends string>({ tabs, active, onChange }: {
  tabs: Array<{ id: T; label: string }>
  active: T
  onChange: (id: T) => void
}) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto whitespace-nowrap border-b border-gray-800 px-4 pt-3 sm:px-6">
      {tabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab.id === active ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
