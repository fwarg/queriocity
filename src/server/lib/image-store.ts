import { unlink } from 'node:fs/promises'

// Diffusion runs are slow by nature (high step counts, large sizes, a shared GPU), so this
// only catches a genuinely stuck server rather than bounding normal work.
export const IMAGE_TIMEOUT_MS = parseInt(process.env.IMAGE_TIMEOUT_MS ?? '300000', 10)

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
