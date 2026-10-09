import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchTopicMap, type Resource, type Space, type TopicMapData, type TopicMember } from '../lib/api.ts'
import { errorMessage } from '../lib/errors.ts'
import { useT } from '../lib/i18n.tsx'
import { SectionHeader } from './SectionHeader.tsx'
import { ViewTabs } from './ViewTabs.tsx'
import { TagTree } from './TagTree.tsx'
import { GlobalGraph } from './GlobalGraph.tsx'
import { LinkReview } from './LinkReview.tsx'
import { TopicMap } from './TopicMap.tsx'

type Tab = 'tags' | 'topics' | 'graph' | 'review'

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
  // The topic map lives here rather than in its tab: the graph colours by it too.
  const [topics, setTopics] = useState<TopicMapData | null>(null)
  const [topicsLoading, setTopicsLoading] = useState(false)
  const [topicsError, setTopicsError] = useState('')
  const [topicsAll, setTopicsAll] = useState(false)
  const [focusTopic, setFocusTopic] = useState<string | null>(null)
  const [reviewQueue, setReviewQueue] = useState<TopicMember[] | undefined>(undefined)

  const loadTopics = useCallback(async (opts: { threshold?: number; all?: boolean } = {}) => {
    setTopicsLoading(true)
    setTopicsError('')
    try {
      setTopics(await fetchTopicMap({ threshold: opts.threshold, all: opts.all ?? topicsAll }))
    } catch (err) { setTopicsError(errorMessage(t, err, t('topics.failed'))) }
    setTopicsLoading(false)
  }, [topicsAll, t])
  // Built on first need — the Topics tab, or the graph's colour-by-topic — not on every visit.
  const wantTopics = tab === 'topics' || focusTopic !== null
  useEffect(() => { if (wantTopics && !topics && !topicsLoading && !topicsError) loadTopics() }, [wantTopics, topics, topicsLoading, topicsError, loadTopics])
  const onNamed = useCallback((key: string, name: string, tag: string | null) => {
    setTopics(d => d && { ...d, topics: d.topics.map(tp => tp.key === key ? { ...tp, name, tag } : tp) })
  }, [])
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
        tabs={[{ id: 'tags' as const, label: t('explore.tabTags') }, { id: 'topics' as const, label: t('explore.tabTopics') }, { id: 'graph' as const, label: t('explore.tabGraph') }, { id: 'review' as const, label: t('explore.tabReview') }]}
        active={tab}
        onChange={next => { if (next === 'review') setReviewQueue(undefined); setTab(next) }}
      />
      <div className="flex flex-col flex-1 overflow-y-auto p-4 sm:p-6 gap-3">
        <SectionHeader title={t('nav.explore')} intro={t(tab === 'tags' ? 'explore.introTags' : tab === 'topics' ? 'explore.introTopics' : tab === 'graph' ? 'explore.introGraph' : 'explore.introReview')} about={t('explore.about')} topic="explore" />
        {tab === 'tags' ? (
          <TagTree
            resources={resources}
            onOpenTag={onOpenTag}
            onShowInGraph={path => { setGraphTag(path); setTab('graph') }}
            onShow={onShow}
            onTagsChanged={onTagsChanged}
          />
        ) : tab === 'topics' ? (
          <TopicMap
            data={topics}
            loading={topicsLoading}
            error={topicsError}
            all={topicsAll}
            onScope={all => { setTopicsAll(all); setTopics(null); loadTopics({ all }) }}
            onThreshold={threshold => loadTopics({ threshold })}
            onRefresh={() => loadTopics({ threshold: topics?.threshold })}
            onNamed={onNamed}
            onOpenResource={onOpenResource}
            onReview={members => { setReviewQueue(members); setTab('review') }}
            onShowInGraph={key => { setFocusTopic(key); setTab('graph') }}
            onChanged={onTagsChanged}
          />
        ) : tab === 'review' ? (
          <LinkReview key={reviewQueue?.map(m => m.id).join() ?? 'all'} resources={resources} onChanged={onTagsChanged} initialQueue={reviewQueue?.filter(m => m.kind === 'note')} />
        ) : (
          <GlobalGraph tags={tagPaths} spaces={spaces} tag={graphTag} onTagChange={setGraphTag} onOpenResource={onOpenResource} onOpenChat={onOpenChat}
            topics={topics?.topics} focusTopic={focusTopic} onFocusTopicChange={setFocusTopic} />
        )}
      </div>
    </div>
  )
}
