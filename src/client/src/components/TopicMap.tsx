import { useEffect, useRef, useState } from 'react'
import { TopicBubbles } from './TopicBubbles.tsx'
import { TopicNoteMap } from './TopicNoteMap.tsx'
import { ChevronDown, ChevronRight, Minus, Network, Plus, RefreshCw } from 'lucide-react'
import { addTagToMany, createNote, nameTopic, type Topic, type TopicMapData, type TopicMember } from '../lib/api.ts'
import { wikilinkFor } from '@shared/wikilinks.ts'
import { normaliseTag } from '@shared/tags.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { EmptyState } from './ui.tsx'

/** How far one press of Coarser/Finer moves the threshold. */
const STEP = 0.05
/** Members listed before "show all". */
const PREVIEW = 5
const VIEW_KEY = 'queriocity.topicView'

type View = 'map' | 'list'
/** What the map shows: the bubbles, or the note map for every note (`topic` absent) or one topic. */
type Level = { notes: false } | { notes: true; topic?: string }

/** The topic map: notes grouped by what they are about, each group with what it lacks — a common
 *  tag, links, an overview — and the actions that supply it. The data is owned by Explore, which
 *  shares it with the graph's colour-by-topic mode. */
export function TopicMap({ data, loading, error, all, onScope, onThreshold, onRefresh, onNamed, onOpenResource, onReview, onShowInGraph, onChanged }: {
  data: TopicMapData | null
  loading: boolean
  error: string
  all: boolean
  onScope: (all: boolean) => void
  onThreshold: (threshold: number) => void
  onRefresh: () => void
  /** A topic got its name; Explore keeps it so the graph legend can use it. */
  onNamed: (key: string, name: string, tag: string | null) => void
  onOpenResource: (id: string) => void
  onReview: (members: TopicMember[]) => void
  onShowInGraph: (key: string) => void
  onChanged: () => void
}) {
  const t = useT()
  const [view, setViewState] = useState<View>(() => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'map' } catch { return 'map' } })
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v) } catch { /* not remembered */ } }
  const [level, setLevel] = useState<Level>({ notes: false })
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  useEffect(() => {
    if (view !== 'list' || !scrollTo) return
    document.getElementById(`topic-${scrollTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setScrollTo(null)
  }, [view, scrollTo])
  // Name unnamed topics one at a time, biggest first, so a local model is not swamped.
  const naming = useRef<string | null>(null)
  useEffect(() => {
    const next = data?.topics.find(tp => !tp.name)
    if (!next || naming.current === next.key) return
    naming.current = next.key
    nameTopic(next.members.map(m => m.id))
      .then(r => onNamed(next.key, r.name, r.tag))
      .catch(() => onNamed(next.key, next.members[0].title, null))
  }, [data, onNamed])

  const threshold = data?.threshold ?? 0
  const button = 'flex items-center gap-1 px-2 py-1 rounded text-xs border border-gray-700 text-gray-300 hover:border-gray-500 disabled:opacity-40'
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {(['map', 'list'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} aria-pressed={view === v}
            className={`px-3 py-1 rounded text-xs border ${view === v ? 'bg-indigo-700 text-white border-indigo-500' : 'text-gray-400 border-gray-700 hover:text-gray-200'}`}>
            {t(v === 'map' ? 'topics.viewMap' : 'topics.viewList')}
          </button>
        ))}
        <span className="w-px h-4 bg-gray-700" />
        {([false, true] as const).map(scope => (
          <button key={String(scope)} onClick={() => onScope(scope)} aria-pressed={all === scope}
            className={`px-3 py-1 rounded text-xs border ${all === scope ? 'bg-gray-700 text-gray-100 border-gray-500' : 'text-gray-400 border-gray-700 hover:text-gray-200'}`}>
            {t(scope ? 'topics.scopeAll' : 'topics.scopeNotes')}
          </button>
        ))}
        <span className="flex items-center gap-1 ml-auto">
          <button onClick={() => onThreshold(Math.max(0, threshold - STEP))} disabled={loading || !data} className={button} title={t('topics.coarserTitle')}>
            <Minus size={12} /> {t('topics.coarser')}
          </button>
          <button onClick={() => onThreshold(Math.min(1, threshold + STEP))} disabled={loading || !data} className={button} title={t('topics.finerTitle')}>
            <Plus size={12} /> {t('topics.finer')}
          </button>
          <button onClick={onRefresh} disabled={loading} className={button} aria-label={t('topics.refresh')} title={t('topics.refresh')}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </span>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && !data && <p className="text-sm text-gray-400">{t('topics.working')}</p>}
      {data && (
        <>
          <p className="text-xs text-gray-500">
            {t('topics.summary', { topics: data.topics.length, loose: data.loose.length, threshold: threshold.toFixed(2) })}
            {data.capped && <> · {t('topics.capped', { count: data.considered })}</>}
          </p>
          {view === 'map' ? (
            level.notes ? (
              <TopicNoteMap
                threshold={threshold}
                all={all}
                topic={level.topic ? data.topics.find(tp => tp.key === level.topic) : undefined}
                topics={data.topics}
                onBack={() => setLevel({ notes: false })}
                onShowCard={key => { setScrollTo(key); setView('list') }}
                onStale={() => { setLevel({ notes: false }); onRefresh() }}
                onOpenResource={onOpenResource}
              />
            ) : data.topics.length === 0
              ? <EmptyState>{t('topics.none')}</EmptyState>
              : <TopicBubbles data={data} onOpenTopic={key => setLevel({ notes: true, topic: key })} onAllNotes={() => setLevel({ notes: true })} />
          ) : (
            <>
              {data.topics.length === 0
                ? <EmptyState>{t('topics.none')}</EmptyState>
                : data.topics.map(topic => (
                  <TopicCard key={topic.key} topic={topic} onOpenResource={onOpenResource} onReview={onReview} onShowInGraph={onShowInGraph} onChanged={onChanged} />
                ))}
              {data.loose.length > 0 && <MemberList title={t('topics.loose', { count: data.loose.length })} members={data.loose} onOpen={onOpenResource} />}
            </>
          )}
        </>
      )}
    </div>
  )
}

function TopicCard({ topic, onOpenResource, onReview, onShowInGraph, onChanged }: {
  topic: Topic
  onOpenResource: (id: string) => void
  onReview: (members: TopicMember[]) => void
  onShowInGraph: (key: string) => void
  onChanged: () => void
}) {
  const t = useT()
  const [tag, setTag] = useState('')
  const [done, setDone] = useState('')
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  // The suggestion fills the field once it arrives, unless the user has typed already.
  useEffect(() => { if (topic.tag) setTag(prev => prev || topic.tag!) }, [topic.tag])

  const ids = topic.members.map(m => m.id)
  const title = (id: string) => topic.members.find(m => m.id === id)?.title ?? id
  const name = topic.name ?? topic.members.slice(0, 2).map(m => m.title).join(' · ')

  async function act(run: () => Promise<string>) {
    setError('')
    try { setDone(await run()); onChanged() } catch (err) { setError(errorMessage(t, err, t('topics.failed'))) }
  }
  const tagAll = () => act(async () => {
    const path = normaliseTag(tag)
    if (!path) throw new Error(t('topics.noTag'))
    return t('topics.tagged', { count: await addTagToMany(path, ids), tag: path })
  })
  const overview = () => act(async () => {
    const body = `${t('topics.overviewIntro')}\n\n${topic.members.map(m => `- ${wikilinkFor(m.title)}`).join('\n')}`
    const path = normaliseTag(tag)
    await createNote(name, body, { tags: path ? [path] : [] })
    return t('topics.overviewCreated', { name })
  })

  return (
    <div id={`topic-${topic.key}`} className="flex flex-col gap-2 rounded-lg border border-gray-800 bg-gray-900/60 p-3">
      <div className="flex items-baseline gap-2">
        <h3 className={`text-sm font-medium break-words ${topic.name ? 'text-gray-100' : 'text-gray-400 italic'}`}>{name}</h3>
        <span className="text-xs text-gray-500 whitespace-nowrap">{t('topics.size', { count: topic.members.length })}</span>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {(showAll ? topic.members : topic.members.slice(0, PREVIEW)).map(m => (
          <li key={m.id}><button onClick={() => onOpenResource(m.id)} className="text-amber-300/90 hover:text-amber-200 text-left break-words">{m.title}</button></li>
        ))}
        {topic.members.length > PREVIEW && (
          <li><button onClick={() => setShowAll(s => !s)} className="text-gray-500 hover:text-gray-300 underline">{showAll ? t('topics.showFewer') : t('topics.showAll', { count: topic.members.length })}</button></li>
        )}
      </ul>
      <ul className="flex flex-col gap-0.5 text-xs text-gray-400">
        <li>{topic.topTag ? t('topics.coverage', { count: topic.topTag.count, total: topic.members.length, tag: topic.topTag.path }) : t('topics.untagged')}</li>
        {topic.tagSpread >= 3 && <li className="text-amber-400">{t('topics.spread', { count: topic.tagSpread })}</li>}
        {topic.unlinked > 0 && <li>{t('topics.unlinked', { count: topic.unlinked })}</li>}
        {topic.duplicates.length > 0 && (
          <li className="text-amber-400">
            {t('topics.duplicates', { count: topic.duplicates.length })}{' '}
            {topic.duplicates.slice(0, 3).map(([a, b]) => `${title(a)} ≈ ${title(b)}`).join('; ')}
          </li>
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input value={tag} onChange={e => setTag(e.target.value)} placeholder={t('topics.tagPlaceholder')} aria-label={t('topics.tagPlaceholder')} autoCapitalize="none"
          className="w-40 text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-100 focus:outline-none focus:border-emerald-600" />
        <button onClick={tagAll} className="px-2 py-1 rounded text-xs bg-emerald-800 text-white hover:bg-emerald-700">{t('topics.tagAll')}</button>
        <button onClick={overview} className="px-2 py-1 rounded text-xs border border-gray-700 text-gray-300 hover:border-gray-500">{t('topics.overview')}</button>
        <button onClick={() => onReview(topic.members)} className="px-2 py-1 rounded text-xs border border-gray-700 text-gray-300 hover:border-gray-500">{t('topics.link')}</button>
        <button onClick={() => onShowInGraph(topic.key)} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-gray-700 text-gray-300 hover:border-gray-500">
          <Network size={12} /> {t('topics.graph')}
        </button>
      </div>
      {done && <p className="text-xs text-emerald-400">{done}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

function MemberList({ title, members, onOpen }: { title: string; members: TopicMember[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="self-start flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {title}
      </button>
      {open && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 pl-4 text-xs">
          {members.map(m => <li key={m.id}><button onClick={() => onOpen(m.id)} className="text-amber-300/90 hover:text-amber-200 text-left">{m.title}</button></li>)}
        </ul>
      )}
    </div>
  )
}
