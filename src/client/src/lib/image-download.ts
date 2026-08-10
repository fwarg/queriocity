import { extractProvenanceChunk, reapplyProvenance } from '@shared/ai-provenance.ts'

/** Visible AI disclosure for downloaded images — EU AI Act Art 50(4).
 *
 *  Drawn as a bar *beneath* the image rather than over it: Art 50(4) requires disclosure "in an
 *  appropriate manner that does not hamper the display or enjoyment of the work". */
const CAPTION = 'AI-generated image · Queriocity'
const CAPTION_HEIGHT = 30
const CAPTION_FONT = '15px system-ui, -apple-system, Segoe UI, sans-serif'

function save(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/** Redraw the image, optionally adding the caption bar. Null if the browser refuses the canvas. */
async function redraw(blob: Blob, caption: boolean): Promise<Blob | null> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height + (caption ? CAPTION_HEIGHT : 0)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  if (caption) {
    ctx.fillStyle = '#111827'
    ctx.fillRect(0, canvas.height - CAPTION_HEIGHT, canvas.width, CAPTION_HEIGHT)
    ctx.fillStyle = '#e5e7eb'
    ctx.font = CAPTION_FONT
    ctx.textBaseline = 'middle'
    ctx.fillText(CAPTION, 10, canvas.height - CAPTION_HEIGHT / 2)
  }

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
}

/** Download a generated image, optionally captioned.
 *
 *  Always redrawn through a canvas, caption or not. The canvas discards every chunk it does not
 *  understand, which includes the diffusion server's `parameters` chunk holding the full prompt —
 *  so this path yields the same sanitised file either way, and the caption setting changes only
 *  whether the image is labelled. Saving straight from the browser still gets the raw file.
 *
 *  The provenance chunk is carried across from the original rather than rebuilt, because the
 *  server records the generating model and the browser has no way to know it. */
export async function downloadGeneratedImage(url: string, filename: string, caption: boolean): Promise<void> {
  const res = await fetch(`${url}?dl=1`)
  if (!res.ok) throw new Error(`Could not fetch image (${res.status})`)
  const original = await res.blob()
  const originalBytes = new Uint8Array(await original.arrayBuffer())

  let redrawn: Blob | null = null
  try {
    redrawn = await redraw(original, caption)
  } catch {
    redrawn = null
  }
  // Better to hand over the untouched marked image than to fail the download outright.
  if (!redrawn) return save(original, filename)

  const marked = reapplyProvenance(
    new Uint8Array(await redrawn.arrayBuffer()),
    extractProvenanceChunk(originalBytes),
    `Queriocity ${__APP_VERSION__}`,
  )
  save(new Blob([marked as BlobPart], { type: 'image/png' }), filename)
}
