import { describe, expect, test } from 'bun:test'
import { answerAsNoteBody } from './note-from-answer.ts'
import type { Message } from './api.ts'

const answer = (partial: Partial<Message>): Message =>
  ({ role: 'assistant', content: '', ...partial }) as Message

const SOURCES = [
  { title: 'Presidentens kansli', url: 'https://presidentti.fi' },
  { title: 'Unused result', url: 'https://example.com/unused' },
  { title: 'Wikipedia', url: 'https://sv.wikipedia.org/wiki/Alexander_Stubb' },
]

describe('answerAsNoteBody', () => {
  test('points each citation marker at its source URL', () => {
    const body = answerAsNoteBody(answer({ content: 'Stubb tillträdde 2024 [1].', sources: SOURCES }), 'Källor')
    expect(body).toContain('[\\[1\\]](https://presidentti.fi)')
  })

  test('lists only the sources the answer cites, keeping their original numbers', () => {
    const body = answerAsNoteBody(answer({ content: 'A [1] and B [3].', sources: SOURCES }), 'Källor')
    expect(body).toContain('- **[1]** [Presidentens kansli](https://presidentti.fi)')
    expect(body).toContain('- **[3]** [Wikipedia](https://sv.wikipedia.org/wiki/Alexander_Stubb)')
    // A research turn accumulates results the writer never used; a note is not a search log.
    expect(body).not.toContain('unused')
    // The numbers must survive: an ordered list would renumber source 3 to 2 and quietly break the
    // correspondence with the markers left in the text.
    expect(body.indexOf('**[3]**')).toBeGreaterThan(-1)
  })

  test('leaves a marker alone when it has no matching source', () => {
    const body = answerAsNoteBody(answer({ content: 'Claim [9].', sources: SOURCES }), 'Källor')
    expect(body).toContain('Claim [9].')
  })

  test('adds nothing when the answer cites nothing', () => {
    const body = answerAsNoteBody(answer({ content: 'Just prose.', sources: SOURCES }), 'Källor')
    expect(body).toBe('Just prose.')
  })

  test('names library documents rather than linking them', () => {
    const body = answerAsNoteBody(
      answer({ content: 'From the spec.', fileSources: [{ title: 'spec.pdf', url: 'file:1', label: 'F1' }] }),
      'Sources',
    )
    expect(body).toContain('- spec.pdf')
    expect(body).not.toContain('file:1')
  })

  test('uses the heading it is given, so the note follows the reader language', () => {
    const body = answerAsNoteBody(answer({ content: 'A [1].', sources: SOURCES }), 'Källor')
    expect(body).toContain('## Källor')
  })
})
