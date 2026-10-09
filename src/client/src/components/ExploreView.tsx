import { useMemo, useState } from 'react'
import type { Resource, Space } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { SectionHeader } from './SectionHeader.tsx'
import { ViewTabs } from './ViewTabs.tsx'
import { TagTree } from './TagTree.tsx'
import { GlobalGraph } from './GlobalGraph.tsx'
import { LinkReview } from './LinkReview.tsx'

type Tab = 'tags' | 'graph' | 'review'

/** An overview of the library's organisation: the tag tree, and the graph of explicit connections.
 *  A tag picked in either carries over to the other. */
export function ExploreView({ resources, spaces, onOpenTag, onShow, onOpenResource, onOpenChat, onTagsChanged }: {
  resources: Resource[]
  spaces: Space[]
  /** Open the library filtered on a tag, or on what still needs organising. */
  onOpenTag: (path: string) => void
  onShow: (what: 'noTags' | 'unlinked') => void
  onOpenResource: (id: string) => void
  onOpenChat: (id: string, title: string) => void
  onTagsChanged: () => void
}) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('tags')
  const [graphTag, setGraphTag] = useState('')
  const tagPaths = useMemo(() => {
    const all = new Set<string>()
    for (const r of resources) for (const tag of r.tags) {
      const parts = tag.split('/')
      for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/'))
    }
    return [...all].sort()
  }, [resources])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ViewTabs
        tabs={[{ id: 'tags' as const, label: t('explore.tabTags') }, { id: 'graph' as const, label: t('explore.tabGraph') }, { id: 'review' as const, label: t('explore.tabReview') }]}
        active={tab}
        onChange={setTab}
      />
      <div className="flex flex-col flex-1 overflow-y-auto p-4 sm:p-6 gap-3">
        <SectionHeader title={t('nav.explore')} intro={t(tab === 'tags' ? 'explore.introTags' : tab === 'graph' ? 'explore.introGraph' : 'explore.introReview')} about={t('explore.about')} topic="explore" />
        {tab === 'tags' ? (
          <TagTree
            resources={resources}
            onOpenTag={onOpenTag}
            onShowInGraph={path => { setGraphTag(path); setTab('graph') }}
            onShow={onShow}
            onTagsChanged={onTagsChanged}
          />
        ) : tab === 'review' ? (
          <LinkReview resources={resources} onChanged={onTagsChanged} />
        ) : (
          <GlobalGraph tags={tagPaths} spaces={spaces} tag={graphTag} onTagChange={setGraphTag} onOpenResource={onOpenResource} onOpenChat={onOpenChat} />
        )}
      </div>
    </div>
  )
}
