import { ExternalLink } from 'lucide-react'
import type { Message } from '../lib/api.ts'

interface Props {
  messages: Message[]
  streaming?: string
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
            {msg.content}
          </div>
          {msg.sources && msg.sources.length > 0 && (
            <div className="flex flex-wrap gap-2 max-w-2xl">
              {msg.sources.map((s, j) => (
                <a
                  key={j}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-blue-400 hover:underline"
                >
                  <ExternalLink size={10} />
                  {s.title || s.url}
                </a>
              ))}
            </div>
          )}
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
