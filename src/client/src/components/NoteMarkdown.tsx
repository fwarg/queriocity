import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { linkNoteCitations, noteSources } from '@shared/note-citations.ts'
import { linkInlineTags } from '@shared/tags.ts'
import { wikilinksToMarkdown, wikilinkTitle } from '../lib/wikilinks.ts'
import { blockMdComponents } from './markdown.tsx'
import { prepareMath } from '../lib/math-markdown.ts'

const CITE_PREFIX = '#cite='
const TAG_PREFIX = '#tag='

type C = { children?: React.ReactNode }

/** A note's markdown, rendered like a chat answer, with `[[wikilinks]]` as in-app links.
 *
 *  Citation markers behave as in the chat: paired with the note's own sources list, shown
 *  superscript, and a click highlights every use of that source and its line in the list, whose link
 *  then leads to the page. Without `onWikilink` (the editor preview) a wikilink is shown but goes
 *  nowhere, since following it would abandon the draft. */
export function NoteMarkdown({ body, onWikilink, onTag }: { body: string; onWikilink?: (title: string) => void; onTag?: (tag: string) => void }) {
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const toggle = (token: string) => setHighlighted(h => h === token ? null : token)

  const sources = useMemo(() => noteSources(body), [body])
  const markdown = useMemo(() => wikilinksToMarkdown(linkInlineTags(
    linkNoteCitations(prepareMath(body), new Set(sources.keys()), t => `${CITE_PREFIX}${encodeURIComponent(t)}`),
    tag => `${TAG_PREFIX}${encodeURIComponent(tag)}`,
  )), [body, sources])

  return (
    <div className="text-sm text-gray-100 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          ...blockMdComponents,
          a: ({ href, children }) => {
            if (href?.startsWith(CITE_PREFIX)) {
              const token = decodeURIComponent(href.slice(CITE_PREFIX.length))
              return (
                <button
                  type="button"
                  onClick={() => toggle(token)}
                  title={sources.get(token)?.title}
                  className={`text-xs align-super leading-none ${highlighted === token ? 'text-yellow-400 font-bold' : 'text-blue-400 hover:text-blue-300'}`}
                >
                  {children}
                </button>
              )
            }
            if (href?.startsWith(TAG_PREFIX)) {
              const tag = decodeURIComponent(href.slice(TAG_PREFIX.length))
              if (!onTag) return <span className="text-emerald-300">{children}</span>
              return <button type="button" onClick={() => onTag(tag)} className="text-emerald-300 hover:text-emerald-200">{children}</button>
            }
            const title = wikilinkTitle(href)
            if (title !== null) {
              if (!onWikilink) return <span className="text-amber-300 underline decoration-dotted">{children}</span>
              return (
                <button type="button" onClick={() => onWikilink(title)} className="text-amber-300 hover:text-amber-200 underline decoration-dotted">
                  {children}
                </button>
              )
            }
            return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{children}</a>
          },
          // The `**[1]**` label of a sources-list line: lit up with its markers, and a toggle too.
          strong: ({ children }: C) => {
            const token = /^\[(\w+)\]$/.exec(String(children))?.[1]
            if (!token || !sources.has(token)) return <strong className="font-semibold text-white">{children}</strong>
            return (
              <button type="button" onClick={() => toggle(token)} className={`font-semibold ${highlighted === token ? 'text-yellow-400 bg-yellow-400/10 rounded px-0.5' : 'text-white'}`}>
                {children}
              </button>
            )
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
