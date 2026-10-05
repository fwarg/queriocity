import React, { createContext, useContext, useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Download, Sparkles } from 'lucide-react'
import { downloadGeneratedImage } from '../lib/image-download.ts'
import { markSvg } from '@shared/ai-provenance.ts'
import { useT } from '../lib/i18n.tsx'

/** Markdown rendering shared by chat answers and notes, so a saved answer reads the same in both.
 *  Element styles are explicit rather than Tailwind's `prose`: the typography plugin is not
 *  installed, and `prose` classes silently do nothing without it. Links are left to each caller —
 *  citations in an answer and wikilinks in a note mean different things. */

/** Whether downloaded images get a visible caption bar burned in. A context rather than a prop
 *  because the markdown component map is module-level, so there is nothing to drill through. */
export const ImageCaptionContext = createContext(true)

/** Escape $ signs immediately preceding a digit (currency amounts) so remark-math doesn't treat them as math delimiters. */
export function escapeCurrencyDollars(content: string): string {
  return content.replace(/\$(?=\d)/g, '\\$')
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

export function ImageBlock({ url, alt }: { url: string; alt: string }) {
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

/** Every element except `a`, styled as in the chat. */
export const blockMdComponents = {
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
}
