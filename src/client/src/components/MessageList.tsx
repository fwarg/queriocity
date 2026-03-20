import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink } from 'lucide-react'
import type { Message } from '../lib/api.ts'

interface Props {
  messages: Message[]
  streaming?: string
  streamingThinking?: string
}

/** Replace [N] with markdown links [[N]](url) so react-markdown renders them as links. */
function insertCitationLinks(content: string, sources: Array<{ url: string }>) {
  return content.replace(/\[(\d+)\]/g, (match, num) => {
    const source = sources[parseInt(num) - 1]
    return source ? `[[${num}]](${source.url})` : match
  })
}

const mdComponents = {
  a: ({ href, children }: any) => {
    const isCitation = /^\[\d+\]$/.test(String(children))
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={isCitation
          ? 'text-blue-400 hover:text-blue-300 text-xs align-super leading-none'
          : 'text-blue-400 hover:underline'}
      >
        {children}
      </a>
    )
  },
  p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold text-white">{children}</strong>,
  h1: ({ children }: any) => <h1 className="text-base font-semibold text-white mb-1 mt-2">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-sm font-semibold text-white mb-1 mt-2">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-sm font-medium text-white mb-1 mt-1">{children}</h3>,
  code: ({ children, className }: any) => {
    const isBlock = className?.startsWith('language-')
    if (isBlock) return <code className={`font-mono text-xs ${className}`}>{children}</code>
    return <code className="bg-gray-700 text-gray-100 rounded px-1 py-0.5 text-xs font-mono">{children}</code>
  },
  pre: ({ children }: any) => <pre className="bg-gray-900 rounded p-3 overflow-x-auto mb-2 text-xs font-mono">{children}</pre>,
  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-gray-600 pl-3 text-gray-400 italic my-2">{children}</blockquote>,
  del: ({ children }: any) => <del className="text-gray-500">{children}</del>,
  input: ({ type, checked }: any) => type === 'checkbox'
    ? <input type="checkbox" checked={checked} readOnly className="mr-2 accent-blue-400" />
    : null,
  table: ({ children }: any) => <div className="overflow-x-auto mb-2"><table className="text-xs border-collapse">{children}</table></div>,
  thead: ({ children }: any) => <thead className="text-gray-300">{children}</thead>,
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => <tr className="border-b border-gray-700">{children}</tr>,
  th: ({ children }: any) => <th className="px-3 py-1 text-left font-semibold border-r border-gray-700 last:border-r-0">{children}</th>,
  td: ({ children }: any) => <td className="px-3 py-1 border-r border-gray-700 last:border-r-0">{children}</td>,
}

function SourceList({ content, sources }: { content: string; sources: Array<{ title: string; url: string }> }) {
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
          className="flex items-center gap-1.5 text-xs text-blue-400 hover:underline"
        >
          <span className="text-gray-500 shrink-0">[{j + 1}]</span>
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
            {showUnused ? '▾' : '▸'} {unused.length} uncited source{unused.length > 1 ? 's' : ''}
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
    </div>
  )
}

function ThinkingBlock({ content, open }: { content: string; open?: boolean }) {
  return (
    <details open={open} className="mb-2 text-xs text-gray-500">
      <summary className="cursor-pointer hover:text-gray-400 select-none">Thinking…</summary>
      <div className="mt-1 pl-2 border-l border-gray-700 whitespace-pre-wrap break-words font-mono text-gray-600 leading-relaxed overflow-x-auto">
        {content}
      </div>
    </details>
  )
}

export function MessageList({ messages, streaming, streamingThinking }: Props) {
  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden flex-1">
      {messages.map((msg, i) => (
        <div key={i} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
          <div
            className={`max-w-2xl min-w-0 rounded-lg px-4 py-2 text-sm break-words ${
              msg.role === 'user'
                ? 'bg-blue-700 text-white whitespace-pre-wrap'
                : 'bg-gray-800 text-gray-100'
            }`}
          >
            {msg.role === 'assistant' ? (
              <>
                {msg.thinking && <ThinkingBlock content={msg.thinking} />}
                <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm]}>
                  {msg.sources?.length ? insertCitationLinks(msg.content, msg.sources) : msg.content}
                </ReactMarkdown>
              </>
            ) : msg.content}
          </div>
          {msg.sources && msg.sources.length > 0 && (
            <SourceList content={msg.content} sources={msg.sources} />
          )}
        </div>
      ))}
      {(streaming || streamingThinking) && (
        <div className="flex items-start">
          <div className="max-w-2xl min-w-0 rounded-lg px-4 py-2 text-sm bg-gray-800 text-gray-100 break-words">
            {streamingThinking && <ThinkingBlock content={streamingThinking} open />}
            {streaming && (
              <>
                <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm]}>{streaming}</ReactMarkdown>
                <span className="animate-pulse">▋</span>
              </>
            )}
            {!streaming && <span className="animate-pulse">▋</span>}
          </div>
        </div>
      )}
    </div>
  )
}
