import { Hono } from 'hono'
import { db, uploadedFiles, getAppSetting } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { ingestFile, extractFileText, isUsableText, ACCEPTED_MIME_TYPES } from '../lib/files/ingest.ts'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'

export const filesRouter = new Hono<AppEnv>()

filesRouter.use('*', authMiddleware)

const MAX_SIZE = 50 * 1024 * 1024 // 50 MB

filesRouter.post('/upload', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.parseBody()
  const file = body['file'] as File | undefined

  if (!file) return c.json({ error: 'No file provided' }, 400)
  if (file.size > MAX_SIZE) return c.json({ error: 'File too large (max 50 MB)' }, 413)
  if (!ACCEPTED_MIME_TYPES.has(file.type.split(';')[0].trim())) {
    return c.json({ error: `Unsupported file type: ${file.type}. Accepted types: PDF, plain text, images.` }, 400)
  }

  const buffer = await file.arrayBuffer()
  console.log(`\n━━━ [upload] "${file.name}"  type=${file.type}  size=${(file.size / 1024).toFixed(0)}KB`)
  try {
    const fileId = await ingestFile(buffer, file.name, file.type, userId)
    console.log(`  [upload] done → fileId=${fileId}`)
    return c.json({ fileId, filename: file.name })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Upload failed'
    console.error(`  [upload] failed: ${msg}`)
    return c.json({ error: msg }, 400)
  }
})

filesRouter.post('/extract', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file'] as File | undefined
  if (!file) return c.json({ error: 'No file provided' }, 400)
  if (file.size > MAX_SIZE) return c.json({ error: 'File too large (max 50 MB)' }, 413)
  if (!ACCEPTED_MIME_TYPES.has(file.type.split(';')[0].trim())) {
    return c.json({ error: `Unsupported file type: ${file.type}. Accepted types: PDF, plain text, images.` }, 400)
  }
  const maxChars = parseInt(await getAppSetting('attachment_chars', '20000'))
  const buffer = await file.arrayBuffer()
  console.log(`\n━━━ [extract] "${file.name}"  type=${file.type}  size=${(file.size / 1024).toFixed(0)}KB`)
  const text = await extractFileText(buffer, file.type)
  if (!isUsableText(text)) {
    return c.json({ error: 'Could not extract readable text from this file. It may be corrupted or in an unsupported encoding.' }, 400)
  }
  console.log(`  [extract] done → ${text.length} chars`)
  return c.json({ filename: file.name, content: text.slice(0, maxChars) })
})

filesRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const files = await db.select({
    id: uploadedFiles.id,
    filename: uploadedFiles.filename,
    mimeType: uploadedFiles.mimeType,
    size: uploadedFiles.size,
    createdAt: uploadedFiles.createdAt,
  }).from(uploadedFiles).where(eq(uploadedFiles.userId, userId))

  return c.json(files)
})

filesRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const fileId = c.req.param('id')

  const file = await db.select().from(uploadedFiles)
    .where(eq(uploadedFiles.id, fileId)).get()

  if (!file) return c.json({ error: 'Not found' }, 404)
  if (file.userId !== userId) return c.json({ error: 'Forbidden' }, 403)

  await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId))

  return c.json({ ok: true })
})
