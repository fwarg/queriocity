import { useState } from 'react'
import { downloadSessionMarkdown, printChat, type ExportScope } from '../lib/chat-export.ts'
import type { Message } from '../lib/api.ts'
import { useLang, useT } from '../lib/i18n.tsx'

/** The Export ▾ menu under a chat: Markdown of the whole chat or its last answer, or print. */
export function ExportMenu({ messages, title }: { messages: Message[]; title?: string }) {
  const t = useT()
  const { lang } = useLang()
  const [open, setOpen] = useState(false)

  function exportAs(scope: ExportScope) {
    downloadSessionMarkdown(messages, title ?? 'chat', scope)
    setOpen(false)
  }

  function print() {
    setOpen(false)
    printChat({
      title: title ?? t('chat.untitled'),
      date: new Date().toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric' }),
      aiNotice: t('notice.printExport'),
    })
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        onBlur={e => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) setOpen(false) }}
        className="text-xs text-gray-600 hover:text-gray-400 flex items-center gap-0.5"
      >
        {t('export.menu')} ▾
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 bg-gray-800 border border-gray-700 rounded shadow-lg z-10 py-1 min-w-max">
          <button onMouseDown={() => exportAs('full')} className="block w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-gray-700">
            {t('export.fullChat')}
          </button>
          <button onMouseDown={() => exportAs('last')} className="block w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-gray-700">
            {t('export.lastAnswer')}
          </button>
          <button onMouseDown={print} className="block w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-gray-700 border-t border-gray-700">
            {t('export.print')}
          </button>
        </div>
      )}
    </div>
  )
}
