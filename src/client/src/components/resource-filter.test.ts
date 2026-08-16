/** The library's filter. Space tagging is the grouping — deliberately not a second taxonomy — so
 *  these guard that the pseudo-values behave, and that the text match covers the three things a user
 *  would actually recall about a resource. */

import { describe, expect, test } from 'bun:test'
import { ALL_SPACES, EMPTY_FILTER, isFiltered, matchesFilter, UNTAGGED } from './ResourceFilters.tsx'
import type { Resource } from '../lib/api.ts'

const resource = (partial: Partial<Resource>): Resource => ({
  id: 'r1',
  filename: 'notes.md',
  mimeType: 'text/markdown',
  size: 10,
  kind: 'note',
  summary: null,
  topics: [],
  spaces: [],
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

  test('matches the filename, the summary and the topics', () => {
    const r = resource({ filename: 'survey.pdf', summary: 'Compares dense retrieval', topics: ['embeddings'] })
    for (const text of ['survey', 'dense', 'embeddings']) {
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

  test('matches a topic exactly, so one topic is not a prefix of another', () => {
    const r = resource({ topics: ['RAG', 'retrieval'] })
    expect(matchesFilter(r, { ...EMPTY_FILTER, topic: 'RAG' })).toBe(true)
    expect(matchesFilter(r, { ...EMPTY_FILTER, topic: 'RA' })).toBe(false)
  })

  test('combines text, space and topic rather than treating them as alternatives', () => {
    const r = resource({ filename: 'survey.pdf', topics: ['RAG'], spaces: [THESIS] })
    expect(matchesFilter(r, { text: 'survey', space: THESIS.id, topic: 'RAG' })).toBe(true)
    expect(matchesFilter(r, { text: 'survey', space: CLIENT.id, topic: 'RAG' })).toBe(false)
    expect(matchesFilter(r, { text: 'other', space: THESIS.id, topic: 'RAG' })).toBe(false)
  })
})

describe('isFiltered', () => {
  test('reports each axis, so the clear-filters affordance appears when it should', () => {
    expect(isFiltered({ ...EMPTY_FILTER, text: 'x' })).toBe(true)
    expect(isFiltered({ ...EMPTY_FILTER, space: UNTAGGED })).toBe(true)
    expect(isFiltered({ ...EMPTY_FILTER, topic: 'RAG' })).toBe(true)
    // Whitespace alone is not a filter — it would otherwise hide the whole list with no explanation.
    expect(isFiltered({ ...EMPTY_FILTER, text: '   ' })).toBe(false)
  })
})
