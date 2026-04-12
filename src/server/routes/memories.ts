import { Hono } from 'hono'
import { db, spaces, spaceMemories, spaceFiles, uploadedFiles, chatSessions, messages, sqlite } from '../lib/db.ts'
import { eq, and, ne } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { getSpaceMemories, saveMemory, compactSpaceMemories, extractMemoriesPostHoc, upsertMemoryEmbedding, deleteMemoryEmbedding } from '../lib/memory.ts'
import { getAppSetting } from '../lib/db.ts'

export const memoriesRouter = new Hono<AppEnv>()

memoriesRouter.use('*', authMiddleware)

/** Verify space belongs to the user, return 404 otherwise. */
async function verifySpaceOwner(spaceId: string, userId: string) {
  return db.select().from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.userId, userId))).get()
}

memoriesRouter.get('/:spaceId/memories', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const memories = await getSpaceMemories(spaceId)
  const { embedded } = sqlite.prepare(
    `SELECT COUNT(*) AS embedded FROM memory_chunks mc
     JOIN space_memories sm ON sm.id = mc.memory_id WHERE sm.space_id = ?`
  ).get(spaceId) as { embedded: number }
  return c.json({ memories, embedded })
})

memoriesRouter.post('/:spaceId/rebuild-embeddings', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const memories = await getSpaceMemories(spaceId)
  let rebuilt = 0
  for (const m of memories) {
    await upsertMemoryEmbedding(m.id, m.content)
    rebuilt++
  }
  console.log(`  [memory] rebuilt ${rebuilt} embeddings for space ${spaceId.slice(0, 8)}`)
  return c.json({ ok: true, rebuilt })
})

memoriesRouter.post('/:spaceId/memories', zValidator('json', z.object({
  content: z.string().min(1).max(500),
})), async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const { content } = c.req.valid('json')
  const id = await saveMemory(spaceId, content, 'manual')
  const memory = await db.select().from(spaceMemories).where(eq(spaceMemories.id, id)).get()
  return c.json(memory, 201)
})

memoriesRouter.patch('/:spaceId/memories/:id', zValidator('json', z.object({
  content: z.string().min(1).max(500),
})), async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  const id = c.req.param('id')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)

  const memory = await db.select().from(spaceMemories)
    .where(and(eq(spaceMemories.id, id), eq(spaceMemories.spaceId, spaceId))).get()
  if (!memory) return c.json({ error: 'Not found' }, 404)

  const { content } = c.req.valid('json')
  await db.update(spaceMemories).set({ content, updatedAt: new Date() })
    .where(eq(spaceMemories.id, id))
  upsertMemoryEmbedding(id, content).catch(e => console.error('[memory] embed failed:', e))
  return c.json({ ok: true })
})

memoriesRouter.delete('/:spaceId/memories/:id', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  const id = c.req.param('id')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)

  const memory = await db.select().from(spaceMemories)
    .where(and(eq(spaceMemories.id, id), eq(spaceMemories.spaceId, spaceId))).get()
  if (!memory) return c.json({ error: 'Not found' }, 404)

  await db.delete(spaceMemories).where(eq(spaceMemories.id, id))
  deleteMemoryEmbedding(id)
  return c.json({ ok: true })
})

memoriesRouter.delete('/:spaceId/memories', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  sqlite.run('DELETE FROM memory_chunks WHERE memory_id IN (SELECT id FROM space_memories WHERE space_id = ?)', [spaceId])
  await db.delete(spaceMemories).where(eq(spaceMemories.spaceId, spaceId))
  return c.json({ ok: true })
})

memoriesRouter.post('/:spaceId/compact', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const targetTokens = parseInt(await getAppSetting('dream_target', '700'))
  const before = (await getSpaceMemories(spaceId)).length
  const compacted = await compactSpaceMemories(spaceId, targetTokens)
  const after = compacted ? (await getSpaceMemories(spaceId)).length : before
  return c.json({ ok: true, before, after, compacted })
})

memoriesRouter.post('/:spaceId/recreate-memories', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)

  // Delete all auto-extracted memories (and their embeddings), keep manual ones
  sqlite.run(`DELETE FROM memory_chunks WHERE memory_id IN (
    SELECT id FROM space_memories WHERE space_id = ? AND source != 'manual'
  )`, [spaceId])
  await db.delete(spaceMemories)
    .where(and(eq(spaceMemories.spaceId, spaceId), ne(spaceMemories.source, 'manual')))

  const chats = await db.select().from(chatSessions).where(eq(chatSessions.spaceId, spaceId))
  const total = chats.length

  const encoder = new TextEncoder()
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })

  const send = (obj: object) => ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))

  ;(async () => {
    // 2KB padding comment to flush browser's initial SSE buffer
    ctrl.enqueue(encoder.encode(': ' + ' '.repeat(2048) + '\n\n'))

    let errors = 0
    for (let i = 0; i < chats.length; i++) {
      send({ processing: i + 1, total })
      const session = chats[i]
      const msgs = await db.select().from(messages).where(eq(messages.sessionId, session.id))
      const userContent = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n\n')
      const assistantContent = msgs.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n')
      if (userContent.trim()) {
        try {
          await extractMemoriesPostHoc(spaceId, session.id, userContent, assistantContent)
        } catch (e) {
          console.error(`  [recreate] extraction failed for session ${session.id.slice(0, 8)}:`, e)
          errors++
        }
      }
    }
    send({ done: true, total, errors })
    ctrl.close()
  })().catch(e => { console.error('[recreate] stream error:', e); ctrl.close() })

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
})

memoriesRouter.get('/:spaceId/files', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const rows = await db.select({
    id: uploadedFiles.id,
    filename: uploadedFiles.filename,
    size: uploadedFiles.size,
    createdAt: uploadedFiles.createdAt,
  })
    .from(spaceFiles)
    .innerJoin(uploadedFiles, eq(spaceFiles.fileId, uploadedFiles.id))
    .where(eq(spaceFiles.spaceId, spaceId))
  return c.json(rows)
})

memoriesRouter.post('/:spaceId/files', zValidator('json', z.object({ fileId: z.string() })), async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  const { fileId } = c.req.valid('json')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  const file = await db.select().from(uploadedFiles)
    .where(and(eq(uploadedFiles.id, fileId), eq(uploadedFiles.userId, userId))).get()
  if (!file) return c.json({ error: 'File not found' }, 404)
  await db.insert(spaceFiles).values({ spaceId, fileId }).onConflictDoNothing()
  return c.json({ ok: true })
})

memoriesRouter.delete('/:spaceId/files/:fileId', async (c) => {
  const userId = c.get('userId') as string
  const spaceId = c.req.param('spaceId')
  const fileId = c.req.param('fileId')
  if (!await verifySpaceOwner(spaceId, userId)) return c.json({ error: 'Not found' }, 404)
  await db.delete(spaceFiles).where(and(eq(spaceFiles.spaceId, spaceId), eq(spaceFiles.fileId, fileId)))
  return c.json({ ok: true })
})
