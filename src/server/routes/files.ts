import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { generateText } from 'ai'
import { db, sqlite, uploadedFiles, spaceFiles, spaces, customTemplates, chatSessions, getAppSetting } from '../lib/db.ts'
import { relatedMinSimilarity, relatedMinRelevance } from '../lib/rag-settings.ts'
import { and, eq } from 'drizzle-orm'
import { ingestFile, extractFileText, isUsableText, ACCEPTED_MIME_TYPES } from '../lib/files/ingest.ts'
import { saveNote, renameResource, addSeeAlso } from '../lib/files/notes.ts'
import { relatedResources } from '../lib/files/related.ts'
import { globalGraph, linkCounts, localGraph } from '../lib/files/graph.ts'
import { deleteTag, listTags, MAX_TAG_CHARS, renameTag, resourceTagList, setResourceTags, suggestedTags, tagsByResource } from '../lib/files/tags.ts'
import { linksOf } from '../lib/files/links.ts'
import { collectResourceText } from '../lib/files/resource-context.ts'
import { operationPrompt, transformPrompt, TRANSFORM_MAX_CHARS, TRANSFORM_OPERATIONS } from '../lib/files/transforms.ts'
import { getChatModel } from '../lib/llm.ts'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { fetchUrl, urlLabel } from '../lib/fetch-url.ts'
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
  try { new URL(url) } catch { return c.json({ error: 'Invalid URL' }, 400) }
  console.log(`\n━━━ [ingest-url] ${url}`)

  const text = await fetchUrl(url)
  if (text.startsWith('Error fetching')) return c.json({ error: `Could not fetch URL: ${text}` }, 400)
  const filename = urlLabel(url)

  const buffer = new TextEncoder().encode(text).buffer as ArrayBuffer
  try {
    // The address itself, not the label derived from it: urlLabel() drops the scheme and
    // truncates, so it cannot be turned back into something fetchable.
    const fileId = await ingestFile(buffer, filename, 'text/plain', userId, url)
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
    origin: uploadedFiles.origin,
    createdAt: uploadedFiles.createdAt,
    updatedAt: uploadedFiles.updatedAt,
  }).from(uploadedFiles).where(eq(uploadedFiles.userId, userId))

  // Space tags come with the list rather than per row: they are what the library is filtered by,
  // and one grouped query beats one request per resource. Scoped through the resources this user
  // owns, so a space someone else tagged the same file to cannot leak in.
  const tags = await db.select({
    fileId: spaceFiles.fileId,
    id: spaces.id,
    name: spaces.name,
  })
    .from(spaceFiles)
    .innerJoin(spaces, eq(spaces.id, spaceFiles.spaceId))
    .innerJoin(uploadedFiles, eq(uploadedFiles.id, spaceFiles.fileId))
    .where(eq(uploadedFiles.userId, userId))

  const byFile = new Map<string, Array<{ id: string; name: string }>>()
  for (const tag of tags) {
    const list = byFile.get(tag.fileId) ?? []
    list.push({ id: tag.id, name: tag.name })
    byFile.set(tag.fileId, list)
  }
  const userTags = tagsByResource(userId)
  const links = linkCounts(userId)

  return c.json(files.map(f => ({
    ...f,
    topics: parseTopics(f.topics),
    tags: userTags.get(f.id) ?? [],
    linkCount: links.get(f.id) ?? 0,
    spaces: byFile.get(f.id) ?? [],
    createdAt: epochSeconds(f.createdAt),
    updatedAt: epochSeconds(f.updatedAt),
  })))
})

/** Drizzle hands back a `Date` for a timestamp column, and `c.json` renders that as an ISO string —
 *  which the client multiplies by 1000 and gets `Invalid Date`. Every other route converts here
 *  rather than in the client, so this one does too. */
const epochSeconds = (d: Date | null) => d ? Math.floor(d.getTime() / 1000) : null

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

const tagList = z.array(z.string().max(MAX_TAG_CHARS)).max(50)

const noteBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
  tags: tagList.optional(),
})

filesRouter.post('/notes', zValidator('json', noteBody.extend({
  derivedFrom: z.string().optional(),
  originSessionId: z.string().optional(),
  originMessageId: z.string().optional(),
})), async (c) => {
  const userId = c.get('userId') as string
  try {
    const id = await saveNote(userId, c.req.valid('json'))
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
      tags: patch.tags,
    })
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Could not save note' }, 400)
  }
})

/** The user's tags with direct counts, for autocomplete and the tag tree. Registered before the
 *  `/:id` routes, which would otherwise take `tags` for an id. */
/** The whole library's explicit connections, optionally narrowed to a tag subtree or a space. */
filesRouter.get('/graph', zValidator('query', z.object({
  tag: z.string().max(MAX_TAG_CHARS).optional(),
  space: z.string().optional(),
  chats: z.enum(['0', '1']).optional(),
})), (c) => {
  const { tag, space, chats } = c.req.valid('query')
  return c.json(globalGraph(c.get('userId') as string, { tag: tag || undefined, spaceId: space || undefined, includeChats: chats === '1' }))
})

filesRouter.get('/tags', (c) => c.json(listTags(c.get('userId') as string)))

/** Rename a tag and everything under it; an existing target merges. */
filesRouter.patch('/tags', zValidator('json', z.object({
  from: z.string().min(1).max(MAX_TAG_CHARS),
  to: z.string().min(1).max(MAX_TAG_CHARS),
})), (c) => {
  const { from, to } = c.req.valid('json')
  try {
    return c.json({ moved: renameTag(c.get('userId') as string, from, to) })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Could not rename tag' }, 400)
  }
})

/** Remove a tag and everything under it from every resource. */
filesRouter.delete('/tags', zValidator('query', z.object({ path: z.string().min(1).max(MAX_TAG_CHARS) })), (c) =>
  c.json({ deleted: deleteTag(c.get('userId') as string, c.req.valid('query').path) }))

/** Replace a resource's tags — any kind of resource, not only notes. */
filesRouter.put('/:id/tags', zValidator('json', z.object({ tags: tagList })), async (c) => {
  const userId = c.get('userId') as string
  const resource = await ownedResource(c.req.param('id'), userId)
  if (!resource) return c.json({ error: 'Not found' }, 404)
  return c.json({ tags: setResourceTags(userId, resource.id, c.req.valid('json').tags) })
})

/** Resources similar in content, from the stored chunk vectors — suggestions, never applied. */
filesRouter.get('/:id/related', async (c) => {
  const userId = c.get('userId') as string
  const resource = await ownedResource(c.req.param('id'), userId)
  if (!resource) return c.json({ error: 'Not found' }, 404)
  const [minSimilarity, minRelevance] = await Promise.all([relatedMinSimilarity(), relatedMinRelevance()])
  return c.json(await relatedResources(userId, resource.id, { minSimilarity, minRelevance }))
})

/** The resource's explicit neighbourhood — links, derivations, chat of origin — to 1 or 2 hops. */
filesRouter.get('/:id/graph', zValidator('query', z.object({ depth: z.coerce.number().int().min(1).max(2).default(1) })), async (c) => {
  const userId = c.get('userId') as string
  const resource = await ownedResource(c.req.param('id'), userId)
  if (!resource) return c.json({ error: 'Not found' }, 404)
  return c.json(localGraph(userId, resource.id, c.req.valid('query').depth))
})

/** Link note `:id` to `targetId` under a "See also" heading, given in the reader's language. */
filesRouter.post('/:id/see-also', zValidator('json', z.object({
  targetId: z.string().min(1),
  heading: z.string().trim().min(1).max(60),
})), async (c) => {
  const { targetId, heading } = c.req.valid('json')
  try {
    await addSeeAlso(c.get('userId') as string, c.req.param('id'), targetId, heading)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Could not add the link' }, 404)
  }
})

/** Renames any resource — an uploaded file and an ingested URL as much as a note.
 *
 *  A filename here is a *title*: nothing writes it to disk or reads an extension from it, and it is
 *  the label the Resources list shows and every retrieval citation carries. So `report_final_v3.pdf`
 *  or `github.com/lfnovo/open-notebook` can be given a name that says what the thing is, and future
 *  citations say it too. Answers already stored keep the name they cited at the time.
 *
 *  No re-indexing: the chunk text is untouched, so the vectors still describe the same content. */
filesRouter.patch('/:id', zValidator('json', z.object({
  // Trimmed before the length check, not after: `min(1)` accepts "   ", and trimming afterwards
  // then writes an empty title — a resource with no name anywhere in the list or its citations.
  filename: z.string().trim().min(1).max(200),
})), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const { filename } = c.req.valid('json')

  const resource = await ownedResource(id, userId)
  if (!resource) return c.json({ error: 'Not found' }, 404)

  await renameResource(userId, id, resource.filename, filename)
  return c.json({ ok: true })
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

  // Provenance both ways: what this note was transformed from, and what has been transformed out of
  // it. Ownership is already established by `resource`, and derived_from can only point at a
  // resource the same user owns, so neither query needs its own user filter.
  const source = resource.derivedFrom
    ? await db.select({ id: uploadedFiles.id, filename: uploadedFiles.filename, kind: uploadedFiles.kind })
        .from(uploadedFiles).where(eq(uploadedFiles.id, resource.derivedFrom)).get()
    : undefined
  const derived = await db.select({ id: uploadedFiles.id, filename: uploadedFiles.filename, kind: uploadedFiles.kind })
    .from(uploadedFiles).where(eq(uploadedFiles.derivedFrom, resource.id))

  // Resolved on read and owner-checked: a deleted chat leaves the id behind and simply shows nothing.
  const originChat = resource.originSessionId
    ? await db.select({ id: chatSessions.id, title: chatSessions.title }).from(chatSessions)
        .where(and(eq(chatSessions.id, resource.originSessionId), eq(chatSessions.userId, userId))).get()
    : undefined
  const tags = resourceTagList(resource.id)

  return c.json({
    ...linksOf(userId, resource.id),
    tags,
    suggestedTags: suggestedTags(parseTopics(resource.topics), tags),
    originChat: originChat ? { ...originChat, messageId: resource.originMessageId } : null,
    derivedFrom: source ?? null,
    derived,
    id: resource.id,
    filename: resource.filename,
    mimeType: resource.mimeType,
    size: resource.size,
    kind: resource.kind,
    body: resource.body,
    summary: resource.summary,
    topics: parseTopics(resource.topics),
    origin: resource.origin,
    createdAt: epochSeconds(resource.createdAt),
    updatedAt: epochSeconds(resource.updatedAt),
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
  // Notes derived from this one keep their text and lose only the link. A database created before
  // notes existed has `derived_from` without its ON DELETE SET NULL — SQLite cannot add a
  // constraint to an existing table — so this is done here rather than left to the schema.
  await db.update(uploadedFiles).set({ derivedFrom: null }).where(eq(uploadedFiles.derivedFrom, fileId))
  await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId))

  return c.json({ ok: true })
})
