import { footnoteCitations, noteSources } from '../../../shared/note-citations.ts'
import { HUMAN_AUTHOR } from '../../../shared/note-trust.ts'

/** The export's Open Knowledge Format (OKF v0.2) flavour: what differs from the Obsidian vault.
 *  Same files and folders; `[[wikilinks]]` become bundle-absolute markdown links, citations become
 *  keyed footnotes with a `sources` list, and each folder gets an `index.md`. Obsidian's own keys
 *  (aliases, spaces, created…) stay, as OKF extensions. */

export const OKF_VERSION = '0.2'

export interface OkfResource {
  kind: 'note' | 'file'
  title: string
  summary: string | null
  origin: string | null
  generatedBy: string | null
  verifiedAt: number | null
  status: string | null
  createdAt: number
}

/** Where each title's file sits, by lowercased title, for links and library-document sources. */
export type PathByTitle = Map<string, string>

const isoTime = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const isWebAddress = (s: string | null): s is string => !!s && /^https?:\/\//i.test(s)

/** `/Notes/My note.md` as a link target: spaces and the like percent-encoded. */
export const linkTarget = (path: string) => encodeURI(`/${path}`)

/** `human:<owner>` for the user's own, `queriocity/<model>` for a model's, after OKF's actors. */
function actor(generatedBy: string, owner: string): string {
  return generatedBy === HUMAN_AUTHOR ? `human:${owner}` : `queriocity/${generatedBy}`
}

/** OKF's keys for one resource, ready to merge into the frontmatter. `owner` names the user in actors. */
export function okfFields(r: OkfResource, body: string, owner: string, paths: PathByTitle): Record<string, unknown> {
  return {
    type: r.kind === 'note' ? 'Note' : isWebAddress(r.origin) ? 'Web page' : 'Document',
    title: r.title,
    description: r.summary ?? undefined,
    resource: isWebAddress(r.origin) ? r.origin : undefined,
    sources: r.kind === 'note' ? noteSourceEntries(body, paths) : undefined,
    generated: r.kind === 'note' && r.generatedBy ? { by: actor(r.generatedBy, owner), at: isoTime(r.createdAt) } : undefined,
    verified: r.verifiedAt ? { by: `human:${owner}`, at: isoTime(r.verifiedAt) } : undefined,
    status: r.status ?? undefined,
  }
}

/** A note's sources list as OKF `sources`, keyed by its citation marker. A library document points
 *  at its exported file when one has that title, else is named as a scope. */
function noteSourceEntries(body: string, paths: PathByTitle) {
  const entries = [...noteSources(body)].map(([id, s]) => {
    const title = s.title.replace(/^\[[A-Za-z]+\d+\]\s*/, '')
    const path = paths.get(title.trim().toLowerCase())
    const resource = s.url ?? (path ? linkTarget(path) : `library document: ${title}`)
    return { id, resource, title }
  })
  return entries.length ? entries : undefined
}

/** A note's text for OKF: links as markdown links, citations as footnotes. A link to a title that
 *  is not in the bundle stays a link to where it would be — OKF reads that as unwritten knowledge. */
export function okfBody(body: string, paths: PathByTitle, fallbackName: (title: string) => string): string {
  const linked = body.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target: string, label?: string) => {
    const path = paths.get(target.trim().toLowerCase()) ?? `Notes/${fallbackName(target.trim())}.md`
    return `[${(label ?? target).trim()}](${linkTarget(path)})`
  })
  return footnoteCitations(linked)
}

export interface IndexItem { folder: string; name: string; title: string; description?: string }

/** `index.md` at the root (listing the folders, carrying `okf_version`) and in each folder. */
export function okfIndexes(items: IndexItem[]): Array<{ path: string; text: string }> {
  const folders = [...new Set(items.map(i => i.folder))]
  const line = (title: string, href: string, description?: string) =>
    `* [${title}](${href})${description ? ` - ${description.replace(/\s+/g, ' ').trim()}` : ''}`
  const root = `---\nokf_version: ${JSON.stringify(OKF_VERSION)}\n---\n\n# Contents\n\n`
    + folders.map(f => line(f, `${encodeURI(f)}/`, `${items.filter(i => i.folder === f).length} items`)).join('\n') + '\n'
  return [
    { path: 'index.md', text: root },
    ...folders.map(f => ({
      path: `${f}/index.md`,
      text: `# ${f}\n\n${items.filter(i => i.folder === f).map(i => line(i.title, encodeURI(`${i.name}.md`), i.description)).join('\n')}\n`,
    })),
  ]
}
