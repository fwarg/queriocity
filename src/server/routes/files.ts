import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { generateText } from 'ai'
import { db, sqlite, uploadedFiles, spaceFiles, spaces, customTemplates, getAppSetting } from '../lib/db.ts'
import { and, eq } from 'drizzle-orm'
import { ingestFile, extractFileText, isUsableText, ACCEPTED_MIME_TYPES } from '../lib/files/ingest.ts'
import { saveNote } from '../lib/files/notes.ts'
import { collectResourceText } from '../lib/files/resource-context.ts'
import { operationPrompt, transformPrompt, TRANSFORM_MAX_CHARS, TRANSFORM_OPERATIONS } from '../lib/files/transforms.ts'
import { getChatModel } from '../lib/llm.ts'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { fetchUrl, extractYoutubeVideoId } from '../lib/fetch-url.ts'
import { rateLimitByUser, ingestLimiter } from '../lib/rate-limit.ts'
import { deleteFileChunks } from '../lib/vector-cleanup.ts'

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
    return c.json({ error: `Unsupported file type: ${file.type}. Accepted: PDF, plain text, Markdown, CSV, HTML, images.` }, 400)
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

filesRouter.post('/ingest-url', rateLimitByUser(ingestLimiter, 'ingest-url'), async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json() as { url?: string }
  const url = body.url?.trim()
  if (!url) return c.json({ error: 'No URL provided' }, 400)
  let parsed: URL
  try { parsed = new URL(url) } catch { return c.json({ error: 'Invalid URL' }, 400) }
  console.log(`\n━━━ [ingest-url] ${url}`)

  const videoId = extractYoutubeVideoId(url)
  const text = await fetchUrl(url)
  if (text.startsWith('Error fetching')) return c.json({ error: `Could not fetch URL: ${text}` }, 400)
  const filename = videoId
    ? `youtube-${videoId}.txt`
    : parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname.replace(/\/$/, '').split('/').pop() ?? '' : '') + '.txt'

  const buffer = new TextEncoder().encode(text).buffer as ArrayBuffer
  try {
    const fileId = await ingestFile(buffer, filename, 'text/plain', userId)
    console.log(`  [ingest-url] done → fileId=${fileId}`)
    return c.json({ fileId, filename }, 201)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Ingest failed'
    return c.json({ error: msg }, 400)
  }
})


filesRouter.post('/extract', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file'] as File | undefined
  if (!file) return c.json({ error: 'No file provided' }, 400)
  if (file.size > MAX_SIZE) return c.json({ error: 'File too large (max 50 MB)' }, 413)
  if (!ACCEPTED_MIME_TYPES.has(file.type.split(';')[0].trim())) {
    return c.json({ error: `Unsupported file type: ${file.type}. Accepted: PDF, plain text, Markdown, CSV, HTML, images.` }, 400)
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
    kind: uploadedFiles.kind,
    summary: uploadedFiles.summary,
    topics: uploadedFiles.topics,
    createdAt: uploadedFiles.createdAt,
    updatedAt: uploadedFiles.updatedAt,
  }).from(uploadedFiles).where(eq(uploadedFiles.userId, userId))

  return c.json(files.map(f => ({ ...f, topics: parseTopics(f.topics) })))
})

/** Topics are stored as a JSON array. A hand-edited or half-written value must not break the list,
 *  which is the one screen a user would go to in order to delete the offending resource. */
function parseTopics(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch { return [] }
}

/** The resource if this user owns it, else undefined — every per-resource route starts here. */
const ownedResource = (id: string, userId: string) =>
  db.select().from(uploadedFiles)
    .where(and(eq(uploadedFiles.id, id), eq(uploadedFiles.userId, userId))).get()

const noteBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
})

filesRouter.post('/notes', zValidator('json', noteBody), async (c) => {
  const userId = c.get('userId') as string
  const { title, body } = c.req.valid('json')
  try {
    const id = await saveNote(userId, { title, body })
    return c.json({ id }, 201)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Could not save note' }, 400)
  }
})

filesRouter.patch('/notes/:id', zValidator('json', noteBody.partial()), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const patch = c.req.valid('json')

  const existing = await ownedResource(id, userId)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.kind !== 'note') return c.json({ error: 'Only notes can be edited' }, 400)

  try {
    await saveNote(userId, {
      id,
      title: patch.title ?? existing.filename,
      body: patch.body ?? existing.body ?? '',
    })
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Could not save note' }, 400)
  }
})

filesRouter.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const resource = await ownedResource(c.req.param('id'), userId)
  if (!resource) return c.json({ error: 'Not found' }, 404)

  const taggedSpaces = await db.select({ id: spaces.id, name: spaces.name })
    .from(spaceFiles)
    .innerJoin(spaces, eq(spaces.id, spaceFiles.spaceId))
    .where(eq(spaceFiles.fileId, resource.id))

  // The chunks rather than a reassembled document: they overlap, so joining them repeats a sentence
  // at every seam, and they are what retrieval actually returns — which is the thing worth seeing
  // when a PDF or a transcript has extracted badly.
  const chunks = sqlite.prepare(`
    SELECT content FROM file_chunk_meta WHERE file_id = ?
    ORDER BY CAST(substr(chunk_id, instr(chunk_id, ':') + 1) AS INTEGER)
  `).all(resource.id) as Array<{ content: string }>

  return c.json({
    id: resource.id,
    filename: resource.filename,
    mimeType: resource.mimeType,
    size: resource.size,
    kind: resource.kind,
    body: resource.body,
    summary: resource.summary,
    topics: parseTopics(resource.topics),
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    spaces: taggedSpaces,
    chunks: chunks.map(ch => ch.content),
  })
})

/** A note's text, for attaching it to a message. Notes only: a file's full text is not stored, and
 *  the overlapping chunks would inject the same passage several times. The paperclip already covers
 *  attaching a document in full. */
filesRouter.get('/:id/text', async (c) => {
  const userId = c.get('userId') as string
  const resource = await ownedResource(c.req.param('id'), userId)
  if (!resource) return c.json({ error: 'Not found' }, 404)
  if (resource.kind !== 'note') return c.json({ error: 'Only notes can be attached from the library' }, 400)

  const maxChars = parseInt(await getAppSetting('attachment_chars', '20000'))
  return c.json({ filename: resource.filename, content: (resource.body ?? '').slice(0, maxChars) })
})

filesRouter.post('/:id/transform', zValidator('json', z.object({
  operation: z.enum(TRANSFORM_OPERATIONS).optional(),
  templateId: z.string().optional(),
})), async (c) => {
  const userId = c.get('userId') as string
  const { operation, templateId } = c.req.valid('json')
  const resource = await ownedResource(c.req.param('id'), userId)
  if (!resource) return c.json({ error: 'Not found' }, 404)

  const { text: context, chunkCount } = collectResourceText([resource.id], TRANSFORM_MAX_CHARS)
  if (!context) return c.json({ error: 'This resource has no indexed content' }, 400)

  let prompt: string
  if (templateId) {
    const template = await db.select().from(customTemplates)
      .where(and(eq(customTemplates.id, templateId), eq(customTemplates.userId, userId))).get()
    if (!template) return c.json({ error: 'Template not found' }, 404)
    prompt = transformPrompt(template.promptText, context)
  } else if (operation) {
    prompt = operationPrompt(operation, context)
  } else {
    return c.json({ error: 'Pick an operation or a template' }, 400)
  }

  console.log(`\n━━━ [transform] file=${resource.id}  ${operation ?? `template:${templateId}`}  ${chunkCount} chunks  ${context.length} chars`)
  const { text } = await generateText({
    model: getChatModel(),
    prompt,
    abortSignal: AbortSignal.timeout(120_000),
  })
  if (!text.trim()) return c.json({ error: 'Model returned empty response' }, 500)

  return c.json({ content: text.trim() })
})

filesRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const fileId = c.req.param('id')

  const file = await db.select().from(uploadedFiles)
    .where(eq(uploadedFiles.id, fileId)).get()

  if (!file) return c.json({ error: 'Not found' }, 404)
  if (file.userId !== userId) return c.json({ error: 'Forbidden' }, 403)

  // Before the row goes: file_chunk_meta has no foreign key and file_chunks is a vec0 table that
  // cannot have one, so nothing else would ever remove them.
  deleteFileChunks(fileId)
  await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId))

  return c.json({ ok: true })
})
