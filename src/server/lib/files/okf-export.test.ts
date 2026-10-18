import { describe, test, expect } from 'bun:test'
import { okfBody, okfFields, okfIndexes, type OkfResource } from './okf-export.ts'
import { fileNames } from './obsidian-export.ts'
import { footnoteCitations } from '../../../shared/note-citations.ts'

const paths = new Map([['paper a', 'Resources/Paper A.md'], ['my note', 'Notes/My note.md']])
const note = (extra: Partial<OkfResource> = {}): OkfResource => ({
  kind: 'note', title: 'T', summary: 'One line.', origin: null, generatedBy: 'GLM', verifiedAt: null, status: null, createdAt: 1_760_000_000, ...extra,
})

describe('OKF export', () => {
  test('wikilinks become bundle-absolute markdown links; a missing target stays a link to where it would be', () => {
    expect(okfBody('See [[My note]] and [[my note|this]] and [[Gone]].', paths, t => t))
      .toBe('See [My note](/Notes/My%20note.md) and [this](/Notes/My%20note.md) and [Gone](/Notes/Gone.md).')
  })

  test('citations become keyed footnotes; a marker with no source stays text', () => {
    const body = 'Claim [1] and [F1], not [9].\n\n## Sources\n\n- **[1]** [Site](https://x.example)\n- **[F1]** [F1] Paper A'
    expect(footnoteCitations(body)).toBe('Claim [^1] and [^F1], not [9].\n\n## Sources\n\n[^1]: [Site](https://x.example)\n[^F1]: [F1] Paper A')
  })

  test('fields: type, sources keyed by marker, model actor, review by the owner', () => {
    const body = 'X [1] [F1]\n\n- **[1]** [Site](https://x.example)\n- **[F1]** [F1] Paper A'
    const f = okfFields(note({ verifiedAt: 1_760_000_100, status: 'draft' }), body, 'fredrik', paths)
    expect(f.type).toBe('Note')
    expect(f.sources).toEqual([
      { id: '1', resource: 'https://x.example', title: 'Site' },
      { id: 'F1', resource: '/Resources/Paper%20A.md', title: 'Paper A' },
    ])
    expect(f.generated).toEqual({ by: 'queriocity/GLM', at: '2025-10-09T08:53:20Z' })
    expect(f.verified).toEqual({ by: 'human:fredrik', at: '2025-10-09T08:55:00Z' })
    expect(f.status).toBe('draft')
  })

  test('the user\'s own note is a human actor; an unknown author and a file have no generated', () => {
    expect(okfFields(note({ generatedBy: 'human' }), '', 'owner', paths).generated).toEqual({ by: 'human:owner', at: '2025-10-09T08:53:20Z' })
    expect(okfFields(note({ generatedBy: null }), '', 'owner', paths).generated).toBeUndefined()
    const page = okfFields(note({ kind: 'file', origin: 'https://site.example/a', generatedBy: null }), '', 'owner', paths)
    expect(page).toMatchObject({ type: 'Web page', resource: 'https://site.example/a' })
  })

  test('index files: root carries okf_version and lists folders, each folder lists its items', () => {
    const [root, notes] = okfIndexes([{ folder: 'Notes', name: 'My note', title: 'My note', description: 'About\nthis.' }])
    expect(root.text).toContain('okf_version: "0.2"')
    expect(root.text).toContain('* [Notes](Notes/) - 1 items')
    expect(notes).toEqual({ path: 'Notes/index.md', text: '# Notes\n\n* [My note](My%20note.md) - About this.\n' })
  })

  test('reserved names are kept free', () => {
    expect(fileNames(['index', 'Log', 'x'], ['index', 'log'])).toEqual(['index (2)', 'Log (2)', 'x'])
  })
})
