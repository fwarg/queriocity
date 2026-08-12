/** Image files outlive the rows that point at them.
 *
 *  A PNG is written before the message referencing it is saved, and the only record that it exists
 *  is markdown inside that message. So a file is stranded whenever a message goes without the
 *  cleanup running: a regenerate deletes the previous answer outright, an aborted turn never
 *  persists one, and an ephemeral run persists nothing at all. Nothing scans image files, so unlike
 *  an orphaned vector they are invisible — they just accumulate. */

import './test-support/test-env.ts'
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { mkdir, rm, writeFile, readdir, utimes } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const DIR = `/tmp/claude-image-cleanup-${randomUUID()}`
process.env.IMAGE_STORAGE_DIR = DIR

const { deleteSupersededImages, deleteUserImages, imageUrlsIn, purgeOrphanImages } =
  await import('./image-store.ts')

const HOUR = 60 * 60 * 1000
const md = (url: string) => `Here it is:\n\n![a cat](${url})`

/** Writes a PNG, aged `ageMs` into the past so the sweep's in-flight guard can be exercised. */
async function seed(userId: string, ageMs = 2 * HOUR): Promise<string> {
  await mkdir(`${DIR}/${userId}`, { recursive: true })
  const name = `${randomUUID()}.png`
  const path = `${DIR}/${userId}/${name}`
  await writeFile(path, 'not really a png')
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
  return `/images/${userId}/${name}`
}

const listed = async (userId: string) => {
  try { return await readdir(`${DIR}/${userId}`) } catch { return [] }
}
const exists = async (url: string) => {
  const [, , userId, name] = url.split('/')
  return (await listed(userId)).includes(name)
}

beforeEach(async () => { await rm(DIR, { recursive: true, force: true }) })
afterAll(async () => { await rm(DIR, { recursive: true, force: true }) })

describe('imageUrlsIn', () => {
  test('finds every referenced image and ignores everything else', () => {
    const urls = imageUrlsIn([
      md('/images/u1/a.png'),
      'no image here, but a link to [something](/images/u1/not-an-image.txt)',
      `${md('/images/u2/b.png')} and ${md('/images/u2/c.png')}`,
    ])
    expect([...urls].sort()).toEqual(['/images/u1/a.png', '/images/u2/b.png', '/images/u2/c.png'])
  })
})

describe('deleteSupersededImages', () => {
  test('deletes the image the regenerate replaced', async () => {
    const [old, fresh] = [await seed('u1'), await seed('u1')]

    await deleteSupersededImages(md(old), md(fresh))

    expect(await exists(old)).toBe(false)
    expect(await exists(fresh)).toBe(true)
  })

  test('keeps an image the new answer still shows', async () => {
    // An edit chain can re-show an earlier render; only what is genuinely dropped may go.
    const kept = await seed('u1')
    await deleteSupersededImages(md(kept), `${md(kept)} and more`)
    expect(await exists(kept)).toBe(true)
  })

  test('does nothing when the old answer had no image', async () => {
    const other = await seed('u1')
    await deleteSupersededImages('just text', md(other))
    expect(await exists(other)).toBe(true)
  })
})

describe('deleteUserImages', () => {
  test('takes the whole directory, including files no message references', async () => {
    const referenced = await seed('u1')
    await seed('u1')                      // already orphaned by an earlier regenerate
    const otherUser = await seed('u2')

    await deleteUserImages('u1')

    expect(await listed('u1')).toEqual([])
    expect(await exists(referenced)).toBe(false)
    expect(await exists(otherUser)).toBe(true)
  })

  test('refuses a user id that is not one, rather than resolving a path', async () => {
    const victim = await seed('u1')
    await deleteUserImages('../u1')
    await deleteUserImages('')
    expect(await exists(victim)).toBe(true)
  })
})

describe('purgeOrphanImages', () => {
  test('deletes what nothing references and keeps what something does', async () => {
    const referenced = await seed('u1')
    const orphan = await seed('u1')
    const otherUsersOrphan = await seed('u2')

    const n = await purgeOrphanImages(imageUrlsIn([md(referenced)]))

    expect(n).toBe(2)
    expect(await exists(referenced)).toBe(true)
    expect(await exists(orphan)).toBe(false)
    expect(await exists(otherUsersOrphan)).toBe(false)
  })

  test('spares a file too young to judge — a turn in flight looks exactly like an orphan', async () => {
    const inFlight = await seed('u1', 5 * 60 * 1000)   // written 5 minutes ago, no message yet

    expect(await purgeOrphanImages(new Set())).toBe(0)
    expect(await exists(inFlight)).toBe(true)
  })

  test('ignores files and directories that are not ours', async () => {
    await mkdir(`${DIR}/u1`, { recursive: true })
    await writeFile(`${DIR}/u1/notes.txt`, 'not an image')
    await mkdir(`${DIR}/.hidden dir`, { recursive: true })
    await writeFile(`${DIR}/.hidden dir/x.png`, 'x')

    expect(await purgeOrphanImages(new Set())).toBe(0)
    expect(await listed('u1')).toEqual(['notes.txt'])
  })

  test('is a no-op when nothing has ever been generated', async () => {
    expect(await purgeOrphanImages(new Set())).toBe(0)
  })
})
