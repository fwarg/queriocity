import React, { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { ExternalLink, FileText, Volume2, VolumeX, NotebookPen, Trash2, Scissors } from 'lucide-react'
import type { Message, Source, FileSource } from '../lib/api.ts'
import { splitGroupedCitations } from '@shared/citations.ts'
import { blockMdComponents, ImageBlock, ImageCaptionContext } from './markdown.tsx'
import { prepareMath } from '../lib/math-markdown.ts'
import { SplitNotesDialog } from './SplitNotesDialog.tsx'

/** Answers shorter than this are one idea already; splitting is offered only above it. */
const SPLIT_MIN_CHARS = 1500
import { useT } from '../lib/i18n.tsx'
import { NoteEditor } from './NoteEditor.tsx'
import { answerAsNoteBody } from '../lib/note-from-answer.ts'
import type { ContextReport } from '@shared/context.ts'
import { ContextDivider, PinButton } from './ContextIndicators.tsx'

export { ImageCaptionContext }

function stripForSpeech(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, 'code block.')
    .replace(/`[^`]+`/g, '')
    .replace(/!\[.*?\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1')
    .replace(/\[(\d+)\]/g, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

interface Props {
  messages: Message[]
  streaming?: string
  streamingThinking?: string
  collapseFirstQuestion?: boolean
  searchQuery?: string
  searchMatchIndices?: number[]
  searchActiveIndex?: number
  /** Opens a resource's detail view by id, given a cited [F1]/[C1] source's `file:${id}` url. */
  onOpenResource?: (id: string) => void
  /** The open chat, recorded on a note saved from one of its answers. */
  sessionId?: string
  /** What the model saw on the latest turn; draws the dividers where its view begins. */
  context?: ContextReport | null
  onTogglePin?: (index: number) => void
  /** A stored message to bring into view once, e.g. the answer a note was saved from. */
  focusMessageId?: string | null
  /** Absent while a run is streaming: deleting then would race the turn being stored. */
  onDeleteTurn?: (index: number) => void
}

/** Normalize SVG blocks: unwrap any existing ```svg fences, then rewrap consistently. */
function wrapSvgBlocks(content: string): string {
  const unwrapped = content.replace(/```svg\s*\n(<svg[\s\S]*?<\/svg>)\s*\n```/gi, '$1')
  return unwrapped.replace(/(<svg[\s\S]*?<\/svg>)/gi, (_m, svg) => `\`\`\`svg\n${svg}\n\`\`\``)
}


/** A citation token as it appears inside [...] — a bare number for a web source ("1"), or a
 *  letter-prefixed label for a resource excerpt ("F1", "C2"). */
const CITATION_TOKEN = /\[(\d+|[A-Za-z]+\d+)\]/g

/** Replace [N] and [F1]/[C1] with markdown links so react-markdown renders them through the same
 *  `a` override. A token matching neither a source index nor a known file label is left as literal
 *  text — this is the fallback for a stray label the model invented past the real resource count. */
function insertCitationLinks(content: string, sources: Array<{ url: string }>, fileSources: Array<{ url: string; label: string }> = []) {
  return splitGroupedCitations(content).replace(CITATION_TOKEN, (match, token: string) => {
    if (/^\d+$/.test(token)) {
      const source = sources[parseInt(token) - 1]
      return source ? `[[${token}]](${source.url})` : match
    }
    const file = fileSources.find(f => f.label === token)
    return file ? `[[${token}]](${file.url})` : match
  })
}


/** Bare hostname for the tooltip's source line; falls back to the raw string. */
function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function makeMdComponents(highlighted: string | null, onCitationClick: (key: string) => void, sources: Source[] = [], fileSources: FileSource[] = []) {
  return {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const match = /^\[(\d+|[A-Za-z]+\d+)\]$/.exec(String(children))
    const token = match ? match[1] : null
    const isNumeric = token !== null && /^\d+$/.test(token)
    const source = token !== null && isNumeric ? sources[parseInt(token) - 1] : undefined
    const fileSource = token !== null && !isNumeric ? fileSources.find(f => f.label === token) : undefined
    const isHighlighted = token !== null && token === highlighted
    if (token !== null) {
      return (
        <span className="relative group inline-block">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-xs align-super leading-none ${isHighlighted ? 'text-yellow-400 font-bold' : 'text-blue-400 hover:text-blue-300'}`}
            onClick={e => { e.preventDefault(); onCitationClick(token) }}
          >
            {children}
          </a>
          {(source || fileSource) && (
            <span
              role="tooltip"
              className="pointer-events-none invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute left-0 bottom-full z-30 mb-1 w-72 max-w-[80vw] rounded border border-gray-700 bg-gray-900 p-2 text-left shadow-xl"
            >
              <span className="block text-xs font-medium text-gray-100 line-clamp-2">{source ? (source.title || source.url) : fileSource!.title}</span>
              {source && <span className="mt-0.5 block truncate text-[10px] text-gray-500">{hostnameOf(source.url)}</span>}
              {source?.content && (
                <span className="mt-1 block text-[11px] leading-snug text-gray-400 line-clamp-4">{source.content}</span>
              )}
            </span>
          )}
        </span>
      )
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
        {children}
      </a>
    )
  },
  ...blockMdComponents,
}}

interface SourceListProps {
  content: string
  sources: Array<{ title: string; url: string }>
  fileSources?: FileSource[]
  highlighted: string | null
  onSourceClick: (key: string) => void
  onOpenResource?: (id: string) => void
}

/** A file source's `url` is a synthetic `file:${id}` marker, not a navigable link — this pulls the
 *  id back out so it can be opened in the Resources view instead. */
function fileIdOf(url: string): string {
  return url.replace(/^file:/, '')
}

/** Cited/uncited split for both web sources ([N]) and resource excerpts ([F1]/[C1]) — a resource
 *  the model never actually cited is exactly as "unused" as an uncited web source, so both fold
 *  into the same toggle rather than the resource always showing under its own heading. */
function SourceList({ content, sources, fileSources = [], highlighted, onSourceClick, onOpenResource }: SourceListProps) {
  const t = useT()
  const [showUnused, setShowUnused] = useState(false)

  const cited = new Set([...splitGroupedCitations(content).matchAll(CITATION_TOKEN)].map(m => m[1]))
  const unusedSources = sources.map((s, j) => ({ s, n: j + 1 })).filter(({ n }) => !cited.has(String(n)))
  const unusedFiles = fileSources.filter(s => !cited.has(s.label))
  const unusedCount = unusedSources.length + unusedFiles.length

  return (
    <div className="flex flex-col gap-1 max-w-2xl">
      {sources.map((s, j) => cited.has(String(j + 1)) && (
        <a
          key={j}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onSourceClick(String(j + 1))}
          className={`flex items-center gap-1.5 text-xs hover:underline rounded px-1 -mx-1 transition-colors ${highlighted === String(j + 1) ? 'text-yellow-400 bg-yellow-400/10' : 'text-blue-400'}`}
        >
          <span className="shrink-0">[{j + 1}]</span>
          <ExternalLink size={10} className="shrink-0" />
          <span className="truncate min-w-0">{s.title || s.url}</span>
        </a>
      ))}
      {fileSources.filter(s => cited.has(s.label)).map(s => (
        <button
          key={s.label}
          onClick={() => { onSourceClick(s.label); onOpenResource?.(fileIdOf(s.url)) }}
          title={onOpenResource ? undefined : s.title}
          className={`flex items-center gap-1.5 text-xs rounded px-1 -mx-1 transition-colors text-left ${highlighted === s.label ? 'text-yellow-400 bg-yellow-400/10' : 'text-gray-400 hover:text-gray-200'} ${onOpenResource ? 'hover:underline' : ''}`}
        >
          <span className="shrink-0">[{s.label}]</span>
          <FileText size={10} className="shrink-0" />
          <span className="truncate min-w-0">{s.title}</span>
        </button>
      ))}
      {unusedCount > 0 && (
        <>
          <button
            onClick={() => setShowUnused(v => !v)}
            className="text-xs text-gray-600 hover:text-gray-400 text-left mt-0.5"
          >
            {showUnused ? '▾' : '▸'} {t('message.uncitedSources', { count: unusedCount })}
          </button>
          {showUnused && (
            <>
              {unusedSources.map(({ s, n }) => (
                <a
                  key={n}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-gray-600 hover:underline"
                >
                  <span className="text-gray-700 shrink-0">[{n}]</span>
                  <ExternalLink size={10} className="shrink-0" />
                  <span className="truncate min-w-0">{s.title || s.url}</span>
                </a>
              ))}
              {unusedFiles.map(s => (
                <button
                  key={s.label}
                  onClick={() => onOpenResource?.(fileIdOf(s.url))}
                  className={`flex items-center gap-1.5 text-xs text-gray-600 text-left ${onOpenResource ? 'hover:underline' : ''}`}
                >
                  <span className="text-gray-700 shrink-0">[{s.label}]</span>
                  <FileText size={10} className="shrink-0" />
                  <span className="truncate min-w-0">{s.title}</span>
                </button>
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}

function ThinkingBlock({ content, open }: { content: string; open?: boolean }) {
  const t = useT()
  return (
    <details open={open} className="mb-2 text-xs text-gray-500">
      <summary className="cursor-pointer hover:text-gray-400 select-none">{t('message.thinking')}</summary>
      <div className="mt-1 pl-2 border-l border-gray-700 whitespace-pre-wrap break-words font-mono text-gray-600 leading-relaxed overflow-x-auto">
        {content}
      </div>
    </details>
  )
}

const baseMdComponents = makeMdComponents(null, () => {})

function escapeRegex(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>
  const parts = text.split(new RegExp(`(${escapeRegex(query)})`, 'gi'))
  return <>{parts.map((p, i) =>
    i % 2 === 1
      ? <mark key={i} className="bg-yellow-500/50 text-white rounded-xs">{p}</mark>
      : p
  )}</>
}

function MessageItem({ msg, isFirst, defaultCollapsed, isMatch, isActive, searchQuery, noteTitle, onOpenResource, sessionId, onTogglePin, onDeleteTurn, keptInFull }: { msg: Message; isFirst?: boolean; defaultCollapsed?: boolean; isMatch?: boolean; isActive?: boolean; searchQuery?: string; noteTitle?: string; onOpenResource?: (id: string) => void; sessionId?: string; onTogglePin?: () => void; onDeleteTurn?: () => void; keptInFull?: boolean }) {
  const t = useT()
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed)
  const [speaking, setSpeaking] = useState(false)
  const [savingNote, setSavingNote] = useState(false)
  const [splitting, setSplitting] = useState(false)
  const [noteSaved, setNoteSaved] = useState(false)
  // Notes saved from this answer: those stored with the chat, plus any saved since it was loaded.
  const [savedHere, setSavedHere] = useState<Array<{ id: string; title: string }>>([])
  const savedNotes = [...(msg.savedNotes ?? []), ...savedHere]
  const toggleSource = useCallback((key: string) => setHighlighted(v => v === key ? null : key), [])
  const mdComponents = makeMdComponents(highlighted, toggleSource, msg.sources, msg.fileSources)

  function handleSpeak() {
    if (speaking) {
      window.speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    window.speechSynthesis.cancel()
    const utt = new SpeechSynthesisUtterance(stripForSpeech(msg.content))
    utt.onstart = () => setSpeaking(true)
    utt.onend = () => setSpeaking(false)
    utt.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(utt)
  }

  const collapsible = isFirst && msg.role === 'user'

  if (collapsible && collapsed) {
    const preview = msg.content.replace(/\s+/g, ' ').trim().slice(0, 80)
    const truncated = msg.content.replace(/\s+/g, ' ').trim().length > 80
    return (
      <div className="flex justify-end w-full">
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 max-w-2xl text-right"
        >
          <ChevronRight size={13} className="shrink-0" />
          <span className="truncate">{preview}{truncated ? '…' : ''}</span>
        </button>
      </div>
    )
  }

  const ringClass = isActive
    ? 'ring-2 ring-yellow-400'
    : isMatch
      ? 'ring-2 ring-yellow-600/50'
      : ''

  return (
    <div data-role={msg.role} className={`flex flex-col gap-1 w-full ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
      <div
        className={`w-full max-w-2xl min-w-0 overflow-x-hidden rounded-lg px-4 py-2 text-sm break-words ${
          msg.role === 'user'
            ? 'bg-blue-700 text-white whitespace-pre-wrap'
            : 'bg-gray-800 text-gray-100'
        } ${ringClass}`}
      >
        {collapsible && (
          <button
            onClick={() => setCollapsed(true)}
            className="float-right ml-2 -mr-1 -mt-0.5 text-blue-300 hover:text-white opacity-60 hover:opacity-100"
            title={t('message.collapse')}
          >
            <ChevronDown size={14} />
          </button>
        )}
        {msg.role === 'assistant' ? (
          <>
            {msg.thinking && <ThinkingBlock content={msg.thinking} />}
            {msg.content && (() => {
              const cited = (msg.sources?.length || msg.fileSources?.length) ? insertCitationLinks(msg.content, msg.sources ?? [], msg.fileSources ?? []) : splitGroupedCitations(msg.content)
              const cleaned = msg.images?.length ? cited.replace(/!\[.*?\]\([^)]+\.png\)/g, '') : cited
              return cleaned.trim() ? <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{wrapSvgBlocks(prepareMath(cleaned))}</ReactMarkdown> : null
            })()}
            {msg.images?.map((img, i) => <ImageBlock key={i} url={img.url} alt={img.alt} />)}
            {msg.content && (
              <div className="flex justify-end items-center gap-2 mt-1">
                {savedNotes.length > 0 && onOpenResource && (
                  <span className="mr-auto flex flex-wrap items-center gap-x-2 min-w-0 text-[11px] text-gray-500">
                    {t('note.savedAs')}
                    {savedNotes.map(n => (
                      <button key={n.id} onClick={() => onOpenResource(n.id)} className="truncate max-w-[12rem] text-amber-400/80 hover:text-amber-300">{n.title}</button>
                    ))}
                  </span>
                )}
                {noteSaved && <span className="text-[11px] text-green-400">{t('note.savedFromAnswer')}</span>}
                {onTogglePin && <PinButton pinned={msg.pinned} keptInFull={keptInFull} onToggle={onTogglePin} />}
                <button
                  onClick={() => setSavingNote(true)}
                  className="p-0.5 rounded text-gray-600 hover:text-amber-400 transition-colors"
                  title={t('note.saveFromAnswer')}
                >
                  <NotebookPen size={13} />
                </button>
                {msg.content.length >= SPLIT_MIN_CHARS && (
                  <button
                    onClick={() => setSplitting(true)}
                    className="p-0.5 rounded text-gray-600 hover:text-amber-400 transition-colors"
                    title={t('split.fromAnswer')}
                  >
                    <Scissors size={13} />
                  </button>
                )}
                {'speechSynthesis' in window && (
                  <button
                    onClick={handleSpeak}
                    className={`p-0.5 rounded transition-colors ${speaking ? 'text-blue-400 hover:text-blue-300' : 'text-gray-600 hover:text-gray-400'}`}
                    title={t(speaking ? 'message.stopReading' : 'message.readAloud')}
                  >
                    {speaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  </button>
                )}
              </div>
            )}
            {splitting && (
              <SplitNotesDialog
                title={noteTitle ?? ''}
                body={answerAsNoteBody(msg, t('note.sources'))}
                options={{ originSessionId: sessionId, originMessageId: msg.id }}
                onClose={() => setSplitting(false)}
                onSaved={notes => { setSplitting(false); setSavedHere(prev => [...prev, ...notes]) }}
              />
            )}
            {savingNote && (
              <NoteEditor
                initialTitle={noteTitle ?? ''}
                initialBody={answerAsNoteBody(msg, t('note.sources'))}
                originSessionId={sessionId}
                originMessageId={msg.id}
                onClose={() => setSavingNote(false)}
                onSaved={(id, title) => {
                  setSavingNote(false)
                  setSavedHere(prev => [...prev, { id, title }])
                  setNoteSaved(true)
                  setTimeout(() => setNoteSaved(false), 3000)
                }}
              />
            )}
          </>
        ) : (
          <>
            <HighlightedText text={msg.content} query={searchQuery ?? ''} />
            {(onTogglePin || onDeleteTurn) && (
              <div className="flex justify-end gap-3 mt-1 whitespace-normal">
                {onDeleteTurn && (
                  <button
                    onClick={() => { if (window.confirm(t('message.deleteTurnConfirm'))) onDeleteTurn() }}
                    title={t('message.deleteTurn')}
                    aria-label={t('message.deleteTurn')}
                    className="p-1 -m-0.5 rounded text-blue-300 hover:text-white opacity-60 hover:opacity-100 transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                {onTogglePin && <PinButton pinned={msg.pinned} keptInFull={keptInFull} onToggle={onTogglePin} onBlue />}
              </div>
            )}
          </>
        )}
      </div>
      {(msg.sources && msg.sources.length > 0 || msg.fileSources && msg.fileSources.length > 0) && (
        <SourceList content={msg.content} sources={msg.sources ?? []} fileSources={msg.fileSources} highlighted={highlighted} onSourceClick={toggleSource} onOpenResource={onOpenResource} />
      )}
    </div>
  )
}

/** A starting title for a note saved from an answer: the question that produced it, trimmed.
 *
 *  The question rather than the chat title — a chat covers many questions, and the one immediately
 *  above is what the answer is about. The user retitles in the editor either way. */
function noteTitleFor(messages: Message[], index: number): string | undefined {
  if (messages[index].role !== 'assistant') return undefined
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const question = messages[i].content.replace(/\s+/g, ' ').trim()
    return question.length > 100 ? `${question.slice(0, 100)}…` : question
  }
  return undefined
}

/** Unpinned messages in [from, to): those the model lost or got only as a summary. */
const unpinnedIn = (messages: Message[], from: number, to: number) =>
  messages.slice(from, to).filter(m => !m.pinned).length

export const MessageList = memo(function MessageList({ messages, streaming, streamingThinking, collapseFirstQuestion, searchQuery, searchMatchIndices, searchActiveIndex, onOpenResource, sessionId, context, onTogglePin, onDeleteTurn, focusMessageId }: Props) {
  const msgRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const matchSet = useMemo(() => new Set(searchMatchIndices ?? []), [searchMatchIndices])

  // Once per id: after the chat loads, centre the message and outline it briefly. Delayed so it
  // wins over the scroll to the bottom that every message-list change triggers.
  const focused = useRef<string | null>(null)
  useEffect(() => {
    if (!focusMessageId || focused.current === focusMessageId) return
    const i = messages.findIndex(m => m.id === focusMessageId)
    const el = msgRefs.current.get(i)
    if (i < 0 || !el) return
    focused.current = focusMessageId
    const timer = setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-amber-400/60', 'rounded-lg')
      setTimeout(() => el.classList.remove('ring-2', 'ring-amber-400/60', 'rounded-lg'), 2500)
    }, 400)
    return () => clearTimeout(timer)
  }, [focusMessageId, messages])

  useEffect(() => {
    if (searchActiveIndex == null || searchActiveIndex < 0) return
    msgRefs.current.get(searchActiveIndex)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [searchActiveIndex])

  return (
    <div data-print-region className="flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden flex-1">
      {messages.map((msg, i) => (
        <div key={i} ref={el => { if (el) msgRefs.current.set(i, el); else msgRefs.current.delete(i) }}>
          {context && i > 0 && i === context.lostBefore && unpinnedIn(messages, 0, i) > 0 && (
            <ContextDivider kind="lost" count={unpinnedIn(messages, 0, i)} />
          )}
          {context && i > context.lostBefore && i === context.cut && unpinnedIn(messages, context.lostBefore, i) > 0 && (
            <ContextDivider kind="summarised" count={unpinnedIn(messages, context.lostBefore, i)} summary={context.summary} />
          )}
          <MessageItem
            msg={msg}
            isFirst={i === 0}
            defaultCollapsed={i === 0 && !!collapseFirstQuestion}
            isMatch={matchSet.has(i)}
            isActive={i === searchActiveIndex}
            searchQuery={searchQuery}
            noteTitle={noteTitleFor(messages, i)}
            onOpenResource={onOpenResource}
            sessionId={sessionId}
            onTogglePin={onTogglePin ? () => onTogglePin(i) : undefined}
            onDeleteTurn={onDeleteTurn ? () => onDeleteTurn(i) : undefined}
            keptInFull={!!context && i < context.cut}
          />
        </div>
      ))}
      {(streaming || streamingThinking) && (
        <div className="flex items-start">
          <div className="w-full max-w-2xl min-w-0 overflow-x-hidden rounded-lg px-4 py-2 text-sm bg-gray-800 text-gray-100 break-words">
            {streamingThinking && <ThinkingBlock content={streamingThinking} open />}
            {streaming && (
              <>
                <ReactMarkdown components={baseMdComponents} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{wrapSvgBlocks(prepareMath(splitGroupedCitations(streaming.replace(/!\[.*?\]\([^)]+\.png\)/g, ''))))}</ReactMarkdown>
                <span className="animate-pulse">▋</span>
              </>
            )}
            {!streaming && <span className="animate-pulse">▋</span>}
          </div>
        </div>
      )}
    </div>
  )
})
