/** The library's filter: spaces (what a resource belongs to) and hierarchical tags (what it is about).
 *  These guard that the pseudo-values behave, that a tag covers its subtree but not a mere prefix,
 *  and that the text match covers what a user would actually recall about a resource. */

import { describe, expect, test } from 'bun:test'
import { ALL_SPACES, EMPTY_FILTER, isFiltered, matchesFilter, tagLevel, toggleSpace, toggleTag, UNTAGGED } from './ResourceFilters.tsx'
import type { Resource } from '../lib/api.ts'

const resource = (partial: Partial<Resource>): Resource => ({
  id: 'r1',
  filename: 'notes.md',
  mimeType: 'text/markdown',
  size: 10,
  kind: 'note',
  summary: null,
  topics: [],
  tags: [],
  linkCount: 0,
  spaces: [],
  origin: null,
  createdAt: 0,
  updatedAt: null,
  ...partial,
})

const THESIS = { id: 'sp1', name: 'Thesis' }
const CLIENT = { id: 'sp2', name: 'Client work' }

describe('matchesFilter', () => {
  test('an empty filter keeps everything', () => {
    expect(matchesFilter(resource({}), EMPTY_FILTER)).toBe(true)
    expect(isFiltered(EMPTY_FILTER)).toBe(false)
  })

  test('matches the filename, the summary, the tags and the suggested topics', () => {
    const r = resource({ filename: 'survey.pdf', summary: 'Compares dense retrieval', tags: ['ml/rag'], topics: ['embeddings'] })
    for (const text of ['survey', 'dense', 'ml/rag', 'embeddings']) {
      expect({ text, hit: matchesFilter(r, { ...EMPTY_FILTER, text }) }).toEqual({ text, hit: true })
    }
    expect(matchesFilter(r, { ...EMPTY_FILTER, text: 'unrelated' })).toBe(false)
  })

  test('ignores case and surrounding whitespace', () => {
    const r = resource({ filename: 'Survey.pdf' })
    expect(matchesFilter(r, { ...EMPTY_FILTER, text: '  SURVEY ' })).toBe(true)
  })

  test('tolerates a resource with no summary', () => {
    // summary is null until the small model has described it, or forever if that is switched off.
    expect(matchesFilter(resource({ summary: null }), { ...EMPTY_FILTER, text: 'notes' })).toBe(true)
  })

  test('narrows to one space, keeping resources tagged to several', () => {
    const both = resource({ spaces: [THESIS, CLIENT] })
    const neither = resource({ spaces: [] })
    expect(matchesFilter(both, { ...EMPTY_FILTER, space: THESIS.id })).toBe(true)
    expect(matchesFilter(both, { ...EMPTY_FILTER, space: CLIENT.id })).toBe(true)
    expect(matchesFilter(neither, { ...EMPTY_FILTER, space: THESIS.id })).toBe(false)
  })

  test('the untagged pseudo-space is the exact complement of being tagged', () => {
    expect(matchesFilter(resource({ spaces: [] }), { ...EMPTY_FILTER, space: UNTAGGED })).toBe(true)
    expect(matchesFilter(resource({ spaces: [THESIS] }), { ...EMPTY_FILTER, space: UNTAGGED })).toBe(false)
    // The two pseudo-values must not collide with a real space id, or one would shadow the other.
    expect(UNTAGGED).not.toBe(ALL_SPACES)
  })

  test('a tag matches itself and its subtree, but not a tag it is merely a prefix of', () => {
    const r = resource({ tags: ['ml/rag'] })
    expect(matchesFilter(r, { ...EMPTY_FILTER, tag: 'ml' })).toBe(true)
    expect(matchesFilter(r, { ...EMPTY_FILTER, tag: 'ml/rag' })).toBe(true)
    expect(matchesFilter(r, { ...EMPTY_FILTER, tag: 'm' })).toBe(false)
    expect(matchesFilter(resource({ tags: ['mlops'] }), { ...EMPTY_FILTER, tag: 'ml' })).toBe(false)
  })

  test('suggested topics do not satisfy a tag filter', () => {
    expect(matchesFilter(resource({ topics: ['rag'] }), { ...EMPTY_FILTER, tag: 'rag', show: '' })).toBe(false)
  })

  test('combines text, space and tag rather than treating them as alternatives', () => {
    const r = resource({ filename: 'survey.pdf', tags: ['rag'], spaces: [THESIS] })
    expect(matchesFilter(r, { text: 'survey', space: THESIS.id, tag: 'rag', show: '' })).toBe(true)
    expect(matchesFilter(r, { text: 'survey', space: CLIENT.id, tag: 'rag', show: '' })).toBe(false)
    expect(matchesFilter(r, { text: 'other', space: THESIS.id, tag: 'rag', show: '' })).toBe(false)
  })
})

/** `isFiltered` decides whether the filter bar is shown at all below the size threshold, and whether
 *  the clear-filters affordance appears. Getting it wrong stranded the user in a narrowed list with
 *  nothing naming the filter and no way out but leaving the view — which is what happened: a row's
 *  chip could set a filter on a library too small for the bar to be rendered. */
describe('what still needs organising', () => {
  test('untagged keeps resources without tags; unlinked keeps notes without links', () => {
    expect(matchesFilter(resource({}), { ...EMPTY_FILTER, show: 'noTags' })).toBe(true)
    expect(matchesFilter(resource({ tags: ['ml'] }), { ...EMPTY_FILTER, show: 'noTags' })).toBe(false)
    expect(matchesFilter(resource({}), { ...EMPTY_FILTER, show: 'unlinked' })).toBe(true)
    expect(matchesFilter(resource({ linkCount: 2 }), { ...EMPTY_FILTER, show: 'unlinked' })).toBe(false)
    expect(matchesFilter(resource({ kind: 'file' }), { ...EMPTY_FILTER, show: 'unlinked' })).toBe(false)
    expect(isFiltered({ ...EMPTY_FILTER, show: 'noTags' })).toBe(true)
  })
})

describe('isFiltered', () => {
  test('reports each axis on its own', () => {
    expect(isFiltered({ ...EMPTY_FILTER, text: 'x' })).toBe(true)
    expect(isFiltered({ ...EMPTY_FILTER, space: UNTAGGED })).toBe(true)
    expect(isFiltered({ ...EMPTY_FILTER, tag: 'rag', show: '' })).toBe(true)
  })

  test('a real space id counts, not only the pseudo-values', () => {
    expect(isFiltered({ ...EMPTY_FILTER, space: THESIS.id })).toBe(true)
  })

  test('the empty filter and whitespace alone are not filters', () => {
    expect(isFiltered(EMPTY_FILTER)).toBe(false)
    // Whitespace would otherwise hide the whole list with no explanation and no visible cause.
    expect(isFiltered({ ...EMPTY_FILTER, text: '   ' })).toBe(false)
  })
})

/** Chips toggle: clicking the one that applied a filter is the obvious way back out, and it is the
 *  affordance a user reaches for first. The two axes have to agree, so both go through one exported
 *  helper each rather than an expression inlined at the call site. */
describe('chip toggling', () => {
  test('a tag chip applies then clears its own filter', () => {
    const applied = toggleTag(EMPTY_FILTER, 'rag')
    expect(applied.tag).toBe('rag')
    expect(toggleTag(applied, 'rag')).toEqual(EMPTY_FILTER)
  })

  test('a space chip applies then clears its own filter', () => {
    const applied = toggleSpace(EMPTY_FILTER, THESIS.id)
    expect(applied.space).toBe(THESIS.id)
    expect(toggleSpace(applied, THESIS.id)).toEqual(EMPTY_FILTER)
  })

  test('a different chip switches rather than clearing', () => {
    const applied = toggleSpace(EMPTY_FILTER, THESIS.id)
    expect(toggleSpace(applied, CLIENT.id).space).toBe(CLIENT.id)
  })

  test('toggling one axis leaves the others alone', () => {
    const both = { text: 'survey', space: THESIS.id, tag: 'rag', show: '' as const }
    expect(toggleTag(both, 'rag')).toEqual({ text: 'survey', space: THESIS.id, tag: '', show: '' })
  })
})

/** The tag drill-down shows one level at a time; a parent counts every resource anywhere under it. */
describe('tagLevel', () => {
  const library = [
    resource({ id: 'a', tags: ['ml/rag', 'ml/eval'] }),
    resource({ id: 'b', tags: ['ml'] }),
    resource({ id: 'c', tags: ['ml/rag/chunking', 'history'] }),
  ]

  test('the top level counts each resource once per root', () => {
    expect(tagLevel(library, '')).toEqual([{ path: 'history', count: 1 }, { path: 'ml', count: 3 }])
  })

  test('a level lists the direct children, counting their subtrees, and not the parent itself', () => {
    expect(tagLevel(library, 'ml')).toEqual([{ path: 'ml/eval', count: 1 }, { path: 'ml/rag', count: 2 }])
    expect(tagLevel(library, 'ml/rag/chunking')).toEqual([])
  })
})
