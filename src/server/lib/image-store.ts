import { unlink } from 'node:fs/promises'

export const IMAGE_STORAGE_DIR = process.env.IMAGE_STORAGE_DIR ?? '/tmp/queriocity/images'

const IMAGE_URL_RE = /!\[.*?\]\((\/images\/[\w-]+\/[\w-]+\.png)\)/g

/** Delete any generated image files referenced in the given message contents. */
export async function deleteSessionImages(contents: string[]): Promise<void> {
  const paths = new Set<string>()
  for (const content of contents) {
    for (const [, url] of content.matchAll(IMAGE_URL_RE)) {
      paths.add(`${IMAGE_STORAGE_DIR}/${url.slice('/images/'.length)}`)
    }
  }
  if (paths.size === 0) return
  await Promise.all([...paths].map(p =>
    unlink(p).catch(() => {}) // ignore missing files
  ))
  console.log(`  [image] deleted ${paths.size} file(s) for session`)
}
