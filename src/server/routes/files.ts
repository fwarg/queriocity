import { Hono } from 'hono'
import { db, uploadedFiles } from '../lib/db.ts'
import { eq } from 'drizzle-orm'
import { ingestFile } from '../lib/files/ingest.ts'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'

export const filesRouter = new Hono<AppEnv>()

filesRouter.use('*', authMiddleware)

filesRouter.post('/upload', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.parseBody()
  const file = body['file'] as File | undefined

  if (!file) return c.json({ error: 'No file provided' }, 400)

  const MAX_SIZE = 50 * 1024 * 1024 // 50 MB
  if (file.size > MAX_SIZE) return c.json({ error: 'File too large (max 50 MB)' }, 413)

  const buffer = await file.arrayBuffer()
  const fileId = await ingestFile(buffer, file.name, file.type, userId)

  return c.json({ fileId, filename: file.name })
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
