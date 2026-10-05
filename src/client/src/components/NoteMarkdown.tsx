import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { wikilinksToMarkdown, wikilinkTitle } from '../lib/wikilinks.ts'

/** A note's markdown, with `[[wikilinks]]` rendered as in-app links.
 *
 *  Shares the renderer with the message list but not its plugins: a note is prose, and citation
 *  links, maths and SVG blocks belong to an answer. Without `onWikilink` (the editor preview) a
 *  wikilink is shown but goes nowhere, since following it would abandon the draft. */
export function NoteMarkdown({ body, onWikilink }: { body: string; onWikilink?: (title: string) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const title = wikilinkTitle(href)
          if (title === null) return <a href={href}>{children}</a>
          if (!onWikilink) return <span className="text-amber-300 underline decoration-dotted">{children}</span>
          return (
            <button type="button" onClick={() => onWikilink(title)} className="text-amber-300 hover:text-amber-200 underline decoration-dotted">
              {children}
            </button>
          )
        },
      }}
    >
      {wikilinksToMarkdown(body)}
    </ReactMarkdown>
  )
}
