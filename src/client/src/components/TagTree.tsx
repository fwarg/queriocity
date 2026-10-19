import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react'
import { deleteTag, renameTag, type Resource } from '../lib/api.ts'
import { buildTagTree, type TagTreeNode } from '../lib/tag-tree.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { useConfirm } from './confirm.tsx'
import { isUnder, normaliseTag } from '@shared/tags.ts'
import { EmptyState } from './ui.tsx'

interface Actions {
  onOpenTag: (path: string) => void
  onShowInGraph: (path: string) => void
  onRename: (path: string, to: string) => Promise<void>
  onMove: (node: TagTreeNode, parent: string) => Promise<void>
  onDelete: (path: string) => Promise<void>
}

/** Every tag as a collapsible tree with counts — the overview the library's one-level filter can't
 *  give. Tapping a tag opens its resources; the row menu renames, moves under another tag, deletes or
 *  shows it in the graph. */
export function TagTree({ resources, onOpenTag, onShowInGraph, onShow, onTagsChanged }: {
  resources: Resource[]
  onOpenTag: (path: string) => void
  onShowInGraph: (path: string) => void
  onShow: (what: 'noTags' | 'unlinked') => void
  onTagsChanged: () => void
}) {
  const t = useT()
  const confirm = useConfirm()
  const [error, setError] = useState('')
  const tree = useMemo(() => buildTagTree(resources), [resources])
  const paths = useMemo(() => descendants(tree).map(n => n.path), [tree])
  const untagged = resources.filter(r => r.tags.length === 0).length
  const unlinked = resources.filter(r => r.kind === 'note' && r.linkCount === 0).length

  const actions: Actions = {
    onOpenTag,
    onShowInGraph,
    async onRename(from, to) {
      if (!to.trim() || to.trim() === from) return
      try { await renameTag(from, to); setError(''); onTagsChanged() } catch (err) { setError(errorMessage(t, err, t('tags.renameFailed'))) }
    },
    /** Moving is renaming to `parent/name`, so sub-tags follow and an existing target merges. */
    async onMove(node, parent) {
      const to = normaliseTag(parent) ? `${normaliseTag(parent)}/${node.name}` : node.name
      if (to === node.path) return
      if (isUnder(to, node.path)) { setError(t('tags.moveIntoItself')); return }
      const subTags = descendants(node.children).length
      const message = t('tags.moveConfirm', { tag: node.path, to, count: node.total, subTags })
      if (await confirm({ message, confirmLabel: t('tags.move') })) await actions.onRename(node.path, to)
    },
    async onDelete(path) {
      if (!await confirm({ message: t('tags.deleteConfirm', { tag: path }), confirmLabel: t('tags.delete'), danger: true })) return
      await deleteTag(path).catch(() => {})
      onTagsChanged()
    },
  }

  return (
    <div className="flex flex-col gap-4">
      {tree.length === 0 ? <EmptyState>{t('explore.noTags')}</EmptyState> : (
        <ul className="flex flex-col">
          {tree.map(n => <TagRow key={n.path} node={n} depth={0} actions={actions} />)}
        </ul>
      )}
      <datalist id={PATHS_LIST}>{paths.map(p => <option key={p} value={p} />)}</datalist>
      {tree.length > 0 && (
        <p className="text-xs text-gray-500">{t('tags.reorganiseHint')}</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex flex-col gap-1 border-t border-gray-800 pt-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">{t('explore.toOrganise')}</h3>
        <button onClick={() => onShow('noTags')} className="flex justify-between py-2 text-sm text-gray-300 hover:text-gray-50">
          <span>{t('explore.untagged')}</span><span className="text-gray-500">{untagged}</span>
        </button>
        <button onClick={() => onShow('unlinked')} className="flex justify-between py-2 text-sm text-gray-300 hover:text-gray-50">
          <span>{t('explore.unlinked')}</span><span className="text-gray-500">{unlinked}</span>
        </button>
      </div>
    </div>
  )
}

const PATHS_LIST = 'tag-tree-paths'

const descendants = (nodes: TagTreeNode[]): TagTreeNode[] => nodes.flatMap(n => [n, ...descendants(n.children)])

/** One tag; its children show when expanded. The top level starts open. */
function TagRow({ node, depth, actions }: { node: TagTreeNode; depth: number; actions: Actions }) {
  const t = useT()
  const [open, setOpen] = useState(depth === 0)
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState<'rename' | 'move' | null>(null)

  const submit = async (value: string) => {
    const mode = editing
    setEditing(null)
    setMenu(false)
    if (mode === 'rename') await actions.onRename(node.path, value)
    if (mode === 'move') await actions.onMove(node, value)
  }
  const prompt = editing === 'move' ? t('tags.moveUnderPrompt', { tag: node.path }) : t('tags.renameTo', { tag: node.path })

  return (
    <li>
      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 16 }}>
        {node.children.length > 0 ? (
          <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={node.path} className="p-2 -m-1 text-gray-500 hover:text-gray-300">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : <span className="w-[14px] mx-1" />}
        {editing ? (
          <input
            autoFocus
            defaultValue={editing === 'rename' ? node.path : parentOf(node.path)}
            list={editing === 'move' ? PATHS_LIST : undefined}
            aria-label={prompt}
            placeholder={prompt}
            autoCapitalize="none"
            onBlur={e => submit(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submit(e.currentTarget.value)
              if (e.key === 'Escape') setEditing(null)
            }}
            className="flex-1 text-sm bg-gray-800 border border-emerald-700 rounded px-2 py-1 text-gray-100 focus:outline-none"
          />
        ) : (
          <button onClick={() => actions.onOpenTag(node.path)} className="flex-1 flex items-baseline gap-2 py-2 text-left text-sm text-emerald-300 hover:text-emerald-200 min-w-0">
            <span className="truncate">#{node.name}</span>
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {node.children.length > 0 ? t('explore.counts', { own: node.own, total: node.total }) : node.total}
            </span>
          </button>
        )}
        <button onClick={() => setMenu(m => !m)} aria-expanded={menu} aria-label={t('explore.tagActions')} className="p-2 text-gray-500 hover:text-gray-300">
          <MoreHorizontal size={14} />
        </button>
      </div>
      {menu && !editing && (
        <div className="flex flex-wrap gap-3 pb-2 text-xs" style={{ paddingLeft: depth * 16 + 28 }}>
          <button onClick={() => { setMenu(false); actions.onShowInGraph(node.path) }} className="py-1 text-gray-400 hover:text-gray-200 underline">{t('explore.showInGraph')}</button>
          <button onClick={() => setEditing('rename')} className="py-1 text-gray-400 hover:text-gray-200 underline">{t('tags.rename')}</button>
          <button onClick={() => setEditing('move')} className="py-1 text-gray-400 hover:text-gray-200 underline">{t('tags.moveUnder')}</button>
          <button onClick={() => { setMenu(false); actions.onDelete(node.path) }} className="py-1 text-gray-400 hover:text-red-300 underline">{t('tags.delete')}</button>
        </div>
      )}
      {open && node.children.length > 0 && (
        <ul>{node.children.map(c => <TagRow key={c.path} node={c} depth={depth + 1} actions={actions} />)}</ul>
      )}
    </li>
  )
}

/** `plants/roses` → `plants`; '' at the top level. */
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')
