import '../test-support/test-env.ts'
import { describe, expect, it, beforeEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { sqlite } from '../db.ts'
import { collectResourceText } from './resource-context.ts'

/** The transforms read a document whole, from the chunks that are its only stored copy. Two things
 *  can go wrong silently there: the chunks come back in the wrong order, handing the model a
 *  scrambled document that still looks plausible, and the size cut lands somewhere that loses a
 *  file's header so its content is attributed to the file before it. */

function seedResource(filename: string, chunks: string[]): string {
  const fileId = randomUUID()
  sqlite.run(
    'INSERT INTO uploaded_files(id, user_id, filename, mime_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)',
    [fileId, 'u1', filename, 'text/plain', 0, 'file', 0],
  )
  chunks.forEach((content, i) => {
    sqlite.run('INSERT INTO file_chunk_meta(chunk_id, file_id, content) VALUES (?,?,?)',
      [`${fileId}:${i}`, fileId, content])
  })
  return fileId
}

beforeEach(() => {
  sqlite.run('DELETE FROM file_chunk_meta')
  sqlite.run('DELETE FROM uploaded_files')
  sqlite.run('INSERT OR IGNORE INTO users(id, email, created_at, updated_at) VALUES (?,?,?,?)',
    ['u1', 'u1@test', 0, 0])
})

describe('collectResourceText', () => {
  it('returns nothing for an empty selection, without touching the database', () => {
    expect(collectResourceText([], 1000)).toEqual({ text: '', chunkCount: 0, truncated: false })
  })

  it('keeps chunks in document order past the tenth', () => {
    // The bug this guards: chunk_id is `<uuid>:<n>`, so ordering by it as text puts 10 before 2.
    // Any file with ten or more chunks — which is most PDFs — was read out of order.
    const contents = Array.from({ length: 12 }, (_, i) => `part-${i}`)
    const id = seedResource('long.txt', contents)

    const { text } = collectResourceText([id], 10_000)
    const positions = contents.map(c => text.indexOf(c))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions.every(p => p >= 0)).toBe(true)
  })

  it('labels each resource once, at its first chunk', () => {
    const a = seedResource('alpha.txt', ['aaa', 'bbb'])
    const b = seedResource('beta.txt', ['ccc'])

    const { text, chunkCount } = collectResourceText([a, b], 10_000)
    expect(text.match(/\[alpha\.txt\]/g)).toHaveLength(1)
    expect(text.match(/\[beta\.txt\]/g)).toHaveLength(1)
    expect(chunkCount).toBe(3)
  })

  it('reports truncation, and counts every chunk rather than the ones it kept', () => {
    const id = seedResource('big.txt', Array.from({ length: 6 }, () => 'x'.repeat(100)))

    const { text, chunkCount, truncated } = collectResourceText([id], 250)
    expect(text.length).toBeLessThanOrEqual(250)
    expect(truncated).toBe(true)
    expect(chunkCount).toBe(6)
  })

  it('is not truncated when everything fits', () => {
    const id = seedResource('small.txt', ['one', 'two'])
    expect(collectResourceText([id], 10_000).truncated).toBe(false)
  })
})
