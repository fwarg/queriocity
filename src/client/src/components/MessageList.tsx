import { ExternalLink } from 'lucide-react'
import type { Message } from '../lib/api.ts'

interface Props {
  messages: Message[]
  streaming?: string
}

function renderWithCitations(content: string, sources: Array<{ title: string; url: string }>) {
  const parts = content.split(/(\[\d+\])/g)
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/)
    if (match) {
      const idx = parseInt(match[1]) - 1
      const source = sources[idx]
      if (source) {
        return (
          <a
            key={i}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 text-xs align-super leading-none"
            title={source.title}
          >
            [{match[1]}]
          </a>
        )
      }
    }
    return part
  })
}

export function MessageList({ messages, streaming }: Props) {
  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto flex-1">
      {messages.map((msg, i) => (
        <div key={i} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
          <div
            className={`max-w-2xl rounded-lg px-4 py-2 text-sm whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-blue-700 text-white'
                : 'bg-gray-800 text-gray-100'
            }`}
          >
            {msg.role === 'assistant' && msg.sources?.length
              ? renderWithCitations(msg.content, msg.sources)
              : msg.content}
          </div>
          {msg.sources && msg.sources.length > 0 && (() => {
            const cited = new Set(
              [...msg.content.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1]))
            )
            const visible = msg.sources.filter((_, j) => cited.has(j + 1))
            if (!visible.length) return null
            return (
              <div className="flex flex-col gap-1 max-w-2xl">
                {msg.sources.map((s, j) => cited.has(j + 1) && (
                  <a
                    key={j}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-blue-400 hover:underline"
                  >
                    <span className="text-gray-500 shrink-0">[{j + 1}]</span>
                    <ExternalLink size={10} className="shrink-0" />
                    <span className="truncate">{s.title || s.url}</span>
                  </a>
                ))}
              </div>
            )
          })()}
        </div>
      ))}
      {streaming && (
        <div className="flex items-start">
          <div className="max-w-2xl rounded-lg px-4 py-2 text-sm bg-gray-800 text-gray-100 whitespace-pre-wrap">
            {streaming}
            <span className="animate-pulse">▋</span>
          </div>
        </div>
      )}
    </div>
  )
}
