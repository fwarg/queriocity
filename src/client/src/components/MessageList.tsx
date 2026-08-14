import React, { useState, useCallback, useContext, useEffect, useRef, useMemo, memo, createContext } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ExternalLink, FileText, Download, Sparkles, Volume2, VolumeX } from 'lucide-react'
import type { Message, Source } from '../lib/api.ts'
import { downloadGeneratedImage } from '../lib/image-download.ts'
import { markSvg } from '@shared/ai-provenance.ts'
import { useT } from '../lib/i18n.tsx'

/** Whether downloaded images get a visible caption bar burned in. A context rather than a prop
 *  because the markdown component map is module-level, so there is nothing to drill through. */
export const ImageCaptionContext = createContext(true)

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
}

/** Normalize SVG blocks: unwrap any existing ```svg fences, then rewrap consistently. */
function wrapSvgBlocks(content: string): string {
  const unwrapped = content.replace(/```svg\s*\n(<svg[\s\S]*?<\/svg>)\s*\n```/gi, '$1')
  return unwrapped.replace(/(<svg[\s\S]*?<\/svg>)/gi, (_m, svg) => `\`\`\`svg\n${svg}\n\`\`\``)
}

/** Escape $ signs immediately preceding a digit (currency amounts) so remark-math doesn't treat them as math delimiters. */
function escapeCurrencyDollars(content: string): string {
  return content.replace(/\$(?=\d)/g, '\\$')
}

/** Replace [N] with markdown links [[N]](url) so react-markdown renders them as links. */
function insertCitationLinks(content: string, sources: Array<{ url: string }>) {
  return content.replace(/\[(\d+)\]/g, (match, num) => {
    const source = sources[parseInt(num) - 1]
    return source ? `[[${num}]](${source.url})` : match
  })
}

type C = { children?: React.ReactNode }

/** Visible AI disclosure. Shown on every generated image rather than only on the ones that would
 *  count as deepfakes under Art 50(4) — nothing here can tell them apart at generation time. */
function AiBadge() {
  const t = useT()
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500" title={t('message.aiBadge')}>
      <Sparkles size={11} /> AI-generated
    </span>
  )
}

function ImageBlock({ url, alt }: { url: string; alt: string }) {
  const t = useT()
  const caption = useContext(ImageCaptionContext)
  const [error, setError] = useState('')

  function handleDownload() {
    setError('')
    downloadGeneratedImage(url, url.split('/').pop() ?? 'image.png', caption ? t('message.imageCaption') : null)
      .catch(e => setError(e instanceof Error ? e.message : t('message.downloadFailed')))
  }

  return (
    <div className="my-2">
      <img src={url} alt={alt} className="max-w-full rounded border border-gray-700" />
      <div className="mt-1 flex items-center gap-3">
        <button onClick={handleDownload} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
          <Download size={12} /> {t('message.downloadPng')}
        </button>
        <AiBadge />
      </div>
      {error && <div className="text-xs text-amber-500">{error}</div>}
    </div>
  )
}

function SvgBlock({ svg }: { svg: string }) {
  const t = useT()
  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([markSvg(svg, `Queriocity ${__APP_VERSION__}`)], { type: 'image/svg+xml' }))
    a.download = 'image.svg'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <div className="my-2">
      <img src={dataUri} alt="SVG output" className="max-w-full rounded border border-gray-700 bg-white" />
      <div className="mt-1 flex items-center gap-3">
        <button onClick={handleDownload} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
          <Download size={12} /> {t('message.downloadSvg')}
        </button>
        <AiBadge />
      </div>
    </div>
  )
}

/** Bare hostname for the tooltip's source line; falls back to the raw string. */
function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function makeMdComponents(highlightedSource: number | null, onCitationClick: (n: number) => void, sources: Source[] = []) {
  return {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const match = /^\[(\d+)\]$/.exec(String(children))
    const num = match ? parseInt(match[1]) : null
    const isHighlighted = num !== null && num === highlightedSource
    if (num !== null) {
      const source = sources[num - 1]
      return (
        <span className="relative group inline-block">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-xs align-super leading-none ${isHighlighted ? 'text-yellow-400 font-bold' : 'text-blue-400 hover:text-blue-300'}`}
            onClick={e => { e.preventDefault(); onCitationClick(num) }}
          >
            {children}
          </a>
          {source && (
            <span
              role="tooltip"
              className="pointer-events-none invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute left-0 bottom-full z-30 mb-1 w-72 max-w-[80vw] rounded border border-gray-700 bg-gray-900 p-2 text-left shadow-xl"
            >
              <span className="block text-xs font-medium text-gray-100 line-clamp-2">{source.title || source.url}</span>
              <span className="mt-0.5 block truncate text-[10px] text-gray-500">{hostnameOf(source.url)}</span>
              {source.content && (
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
  p: ({ children }: C) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: C) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: C) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: C) => <li>{children}</li>,
  strong: ({ children }: C) => <strong className="font-semibold text-white">{children}</strong>,
  h1: ({ children }: C) => <h1 className="text-base font-semibold text-white mb-1 mt-2">{children}</h1>,
  h2: ({ children }: C) => <h2 className="text-sm font-semibold text-white mb-1 mt-2">{children}</h2>,
  h3: ({ children }: C) => <h3 className="text-sm font-medium text-white mb-1 mt-1">{children}</h3>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const match = /language-(\w+)/.exec(className || '')
    if (match) {
      const src = String(children).replace(/\n$/, '')
      if (match[1] === 'svg') return <SvgBlock svg={src} />
      return (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          customStyle={{ margin: '0 0 0.5rem', borderRadius: '0.375rem', padding: '0.75rem', fontSize: '0.75rem' }}
        >
          {src}
        </SyntaxHighlighter>
      )
    }
    return <code className="bg-gray-700 text-gray-100 rounded px-1 py-0.5 text-xs font-mono">{children}</code>
  },
  img: ({ src, alt }: { src?: string; alt?: string }) => src ? <ImageBlock url={src} alt={alt ?? ''} /> : null,
  pre: ({ children }: C) => <>{children}</>,
  blockquote: ({ children }: C) => <blockquote className="border-l-2 border-gray-600 pl-3 text-gray-400 italic my-2">{children}</blockquote>,
  del: ({ children }: C) => <del className="text-gray-500">{children}</del>,
  input: ({ type, checked }: { type?: string; checked?: boolean }) => type === 'checkbox'
    ? <input type="checkbox" checked={checked} readOnly className="mr-2 accent-blue-400" />
    : null,
  table: ({ children }: C) => <div className="overflow-x-auto mb-2"><table className="text-xs border-collapse">{children}</table></div>,
  thead: ({ children }: C) => <thead className="text-gray-300">{children}</thead>,
  tbody: ({ children }: C) => <tbody>{children}</tbody>,
  tr: ({ children }: C) => <tr className="border-b border-gray-700">{children}</tr>,
  th: ({ children }: C) => <th className="px-3 py-1 text-left font-semibold border-r border-gray-700 last:border-r-0">{children}</th>,
  td: ({ children }: C) => <td className="px-3 py-1 border-r border-gray-700 last:border-r-0">{children}</td>,
}}

interface SourceListProps {
  content: string
  sources: Array<{ title: string; url: string }>
  fileSources?: Array<{ title: string; url: string }>
  highlightedSource: number | null
  onSourceClick: (n: number) => void
}

function SourceList({ content, sources, fileSources, highlightedSource, onSourceClick }: SourceListProps) {
  const t = useT()
  const [showUnused, setShowUnused] = useState(false)

  const cited = new Set(
    [...content.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1]))
  )
  const unused = sources.filter((_, j) => !cited.has(j + 1))

  return (
    <div className="flex flex-col gap-1 max-w-2xl">
      {sources.map((s, j) => cited.has(j + 1) && (
        <a
          key={j}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onSourceClick(j + 1)}
          className={`flex items-center gap-1.5 text-xs hover:underline rounded px-1 -mx-1 transition-colors ${highlightedSource === j + 1 ? 'text-yellow-400 bg-yellow-400/10' : 'text-blue-400'}`}
        >
          <span className="shrink-0">[{j + 1}]</span>
          <ExternalLink size={10} className="shrink-0" />
          <span className="truncate min-w-0">{s.title || s.url}</span>
        </a>
      ))}
      {unused.length > 0 && (
        <>
          <button
            onClick={() => setShowUnused(v => !v)}
            className="text-xs text-gray-600 hover:text-gray-400 text-left mt-0.5"
          >
            {showUnused ? '▾' : '▸'} {t('message.uncitedSources', { count: unused.length })}
          </button>
          {showUnused && sources.map((s, j) => !cited.has(j + 1) && (
            <a
              key={j}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-gray-600 hover:underline"
            >
              <span className="text-gray-700 shrink-0">[{j + 1}]</span>
              <ExternalLink size={10} className="shrink-0" />
              <span className="truncate min-w-0">{s.title || s.url}</span>
            </a>
          ))}
        </>
      )}
      {fileSources && fileSources.length > 0 && (
        <div className={`flex flex-col gap-0.5 ${sources.length > 0 ? 'mt-1 pt-1 border-t border-gray-800' : ''}`}>
          <span className="text-xs text-gray-600">{t('message.documentContext')}</span>
          {fileSources.map(s => (
            <span key={s.url} className="flex items-center gap-1.5 text-xs text-gray-500">
              <FileText size={10} className="shrink-0" />
              <span className="truncate min-w-0">{s.title}</span>
            </span>
          ))}
        </div>
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

function MessageItem({ msg, isFirst, defaultCollapsed, isMatch, isActive, searchQuery }: { msg: Message; isFirst?: boolean; defaultCollapsed?: boolean; isMatch?: boolean; isActive?: boolean; searchQuery?: string }) {
  const t = useT()
  const [highlightedSource, setHighlightedSource] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed)
  const [speaking, setSpeaking] = useState(false)
  const toggleSource = useCallback((n: number) => setHighlightedSource(v => v === n ? null : n), [])
  const mdComponents = makeMdComponents(highlightedSource, toggleSource, msg.sources)

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
              const cited = msg.sources?.length ? insertCitationLinks(msg.content, msg.sources) : msg.content
              const cleaned = msg.images?.length ? cited.replace(/!\[.*?\]\([^)]+\.png\)/g, '') : cited
              return cleaned.trim() ? <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{wrapSvgBlocks(escapeCurrencyDollars(cleaned))}</ReactMarkdown> : null
            })()}
            {msg.images?.map((img, i) => <ImageBlock key={i} url={img.url} alt={img.alt} />)}
            {'speechSynthesis' in window && msg.content && (
              <div className="flex justify-end mt-1">
                <button
                  onClick={handleSpeak}
                  className={`p-0.5 rounded transition-colors ${speaking ? 'text-blue-400 hover:text-blue-300' : 'text-gray-600 hover:text-gray-400'}`}
                  title={t(speaking ? 'message.stopReading' : 'message.readAloud')}
                >
                  {speaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
              </div>
            )}
          </>
        ) : <HighlightedText text={msg.content} query={searchQuery ?? ''} />}
      </div>
      {(msg.sources && msg.sources.length > 0 || msg.fileSources && msg.fileSources.length > 0) && (
        <SourceList content={msg.content} sources={msg.sources ?? []} fileSources={msg.fileSources} highlightedSource={highlightedSource} onSourceClick={toggleSource} />
      )}
    </div>
  )
}

export const MessageList = memo(function MessageList({ messages, streaming, streamingThinking, collapseFirstQuestion, searchQuery, searchMatchIndices, searchActiveIndex }: Props) {
  const msgRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const matchSet = useMemo(() => new Set(searchMatchIndices ?? []), [searchMatchIndices])

  useEffect(() => {
    if (searchActiveIndex == null || searchActiveIndex < 0) return
    msgRefs.current.get(searchActiveIndex)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [searchActiveIndex])

  return (
    <div data-print-region className="flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden flex-1">
      {messages.map((msg, i) => (
        <div key={i} ref={el => { if (el) msgRefs.current.set(i, el); else msgRefs.current.delete(i) }}>
          <MessageItem
            msg={msg}
            isFirst={i === 0}
            defaultCollapsed={i === 0 && !!collapseFirstQuestion}
            isMatch={matchSet.has(i)}
            isActive={i === searchActiveIndex}
            searchQuery={searchQuery}
          />
        </div>
      ))}
      {(streaming || streamingThinking) && (
        <div className="flex items-start">
          <div className="w-full max-w-2xl min-w-0 overflow-x-hidden rounded-lg px-4 py-2 text-sm bg-gray-800 text-gray-100 break-words">
            {streamingThinking && <ThinkingBlock content={streamingThinking} open />}
            {streaming && (
              <>
                <ReactMarkdown components={baseMdComponents} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{wrapSvgBlocks(escapeCurrencyDollars(streaming.replace(/!\[.*?\]\([^)]+\.png\)/g, '')))}</ReactMarkdown>
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
