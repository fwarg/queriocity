import { describe, test, expect } from 'bun:test'
import { linkNoteCitations, noteSources, plainCitations } from './note-citations.ts'

const NOTE = `Stubb tillträdde 2024 [1][3], enligt [F1].

---

## Källor

- **[1]** [Presidentens kansli](https://presidentti.fi)
- **[3]** [Wikipedia](https://sv.wikipedia.org/wiki/Alexander_Stubb)
- **[F1]** spec.pdf
`

describe('noteSources', () => {
  test('reads web sources with URLs and library documents without', () => {
    expect([...noteSources(NOTE)]).toEqual([
      ['1', { title: 'Presidentens kansli', url: 'https://presidentti.fi' }],
      ['3', { title: 'Wikipedia', url: 'https://sv.wikipedia.org/wiki/Alexander_Stubb' }],
      ['F1', { title: 'spec.pdf', url: null }],
    ])
  })
})

describe('linkNoteCitations', () => {
  const link = (body: string) => linkNoteCitations(body, new Set(noteSources(NOTE).keys()), t => `#cite=${t}`)

  test('links markers that have a source, adjacent ones included', () => {
    expect(link('A [1][3] and [F1].')).toBe('A [\\[1\\]](#cite=1)[\\[3\\]](#cite=3) and [\\[F1\\]](#cite=F1).')
  })

  test('leaves unknown markers, source labels, wikilinks, links and code alone', () => {
    const body = 'Claim [9]. - **[1]** x. See [[1]], [1](https://a.b), `[1]`.'
    expect(link(body)).toBe(body)
  })
})

describe('plainCitations', () => {
  test('turns old-form markers back into plain ones when the list holds the same URL', () => {
    const old = NOTE.replace('2024 [1][3]', '2024 [\\[1\\]](https://presidentti.fi)[\\[3\\]](https://sv.wikipedia.org/wiki/Alexander_Stubb)')
    expect(plainCitations(old)).toBe(NOTE)
  })

  test('keeps a linked marker whose URL the list does not hold', () => {
    const body = `A [\\[1\\]](https://elsewhere.example).\n\n- **[1]** [Presidentens kansli](https://presidentti.fi)`
    expect(plainCitations(body)).toBe(body)
  })
})
