import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { wikilinksToMarkdown, wikilinkTitle } from '../lib/wikilinks.ts'
import { blockMdComponents, escapeCurrencyDollars } from './markdown.tsx'

/** A saved answer's `[\[3\]](url)` citation: shown superscript, as in the chat it came from. */
const CITATION = /^\[[A-Za-z]?\d+\]$/

/** A note's markdown, rendered like a chat answer, with `[[wikilinks]]` as in-app links.
 *
 *  Without `onWikilink` (the editor preview) a wikilink is shown but goes nowhere, since following
 *  it would abandon the draft. */
export function NoteMarkdown({ body, onWikilink }: { body: string; onWikilink?: (title: string) => void }) {
  return (
    <div className="text-sm text-gray-100 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          ...blockMdComponents,
          a: ({ href, children }) => {
            const title = wikilinkTitle(href)
            if (title !== null) {
              if (!onWikilink) return <span className="text-amber-300 underline decoration-dotted">{children}</span>
              return (
                <button type="button" onClick={() => onWikilink(title)} className="text-amber-300 hover:text-amber-200 underline decoration-dotted">
                  {children}
                </button>
              )
            }
            const citation = CITATION.test(String(children))
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={citation ? 'text-xs align-super leading-none text-blue-400 hover:text-blue-300' : 'text-blue-400 hover:underline'}
              >
                {children}
              </a>
            )
          },
        }}
      >
        {wikilinksToMarkdown(escapeCurrencyDollars(body))}
      </ReactMarkdown>
    </div>
  )
}
