import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db, sqlite, customTemplates } from '../lib/db.ts'
import { eq, and, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { trustByNote } from '../lib/files/note-trust.ts'
import { COLLECTION_MODES } from '../../shared/context.ts'
import { MAX_EXAMPLES, MAX_INSTRUCTION_NOTES, type RecipeSettings } from '../../shared/recipes.ts'

export const templatesRouter = new Hono<AppEnv>()
templatesRouter.use('*', authMiddleware)

templatesRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await db.select().from(customTemplates)
    .where(eq(customTemplates.userId, userId))
    .orderBy(desc(customTemplates.createdAt))
  return c.json(rows.map(r => templateJson(userId, r)))
})

type TemplateRow = typeof customTemplates.$inferSelect

/** A template as the client sees it: a recipe's notes and examples named, and the ones since
 *  deleted left out. `trust` lets the chip warn about an unreviewed instruction note. */
function templateJson(userId: string, r: TemplateRow) {
  const notes = titled(userId, ids(r.instructionNoteIds))
  const trust = trustByNote(notes.map(n => n.id))
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    promptText: r.promptText,
    suggestedMode: r.suggestedMode,
    instructions: notes.map(n => ({ ...n, trust: trust.get(n.id)?.trust ?? 'unknown' })),
    examples: titled(userId, ids(r.exampleFileIds)),
    settings: r.settings ? JSON.parse(r.settings) as RecipeSettings : {},
    createdAt: Math.floor((r.createdAt as Date).getTime() / 1000),
  }
}

const ids = (json: string | null): string[] => json ? JSON.parse(json) as string[] : []

/** The given resources the user owns, with titles, in the given order. */
function titled(userId: string, fileIds: string[]): Array<{ id: string; title: string }> {
  if (!fileIds.length) return []
  const rows = sqlite.query(`SELECT id, filename AS title FROM uploaded_files WHERE user_id = ? AND id IN (${fileIds.map(() => '?').join(',')})`)
    .all(userId, ...fileIds) as Array<{ id: string; title: string }>
  return fileIds.flatMap(id => rows.filter(r => r.id === id))
}

/** A recipe's parts as stored; null for a plain template's. */
function recipeColumns(body: Partial<z.infer<typeof templateBody>>) {
  return {
    ...(body.instructionNoteIds && { instructionNoteIds: body.instructionNoteIds.length ? JSON.stringify(body.instructionNoteIds) : null }),
    ...(body.exampleFileIds && { exampleFileIds: body.exampleFileIds.length ? JSON.stringify(body.exampleFileIds) : null }),
    ...(body.settings && { settings: Object.keys(body.settings).length ? JSON.stringify(body.settings) : null }),
  }
}

const templateBody = z.object({
  name: z.string().min(1).max(100),
  promptText: z.string().min(1).max(10000),
  suggestedMode: z.enum(['flash', 'balanced', 'thorough', 'image']).default('balanced'),
  description: z.string().max(200).optional(),
  instructionNoteIds: z.array(z.string()).max(MAX_INSTRUCTION_NOTES).optional(),
  exampleFileIds: z.array(z.string()).max(MAX_EXAMPLES).optional(),
  settings: z.object({
    collectionIds: z.array(z.string()).max(20).optional(),
    collectionMode: z.enum(COLLECTION_MODES).optional(),
    exploreWeb: z.boolean().optional(),
  }).optional(),
})

templatesRouter.post('/', zValidator('json', templateBody), async (c) => {
  const userId = c.get('userId') as string
  const body = c.req.valid('json')
  const now = new Date()
  const id = randomUUID()
  await db.insert(customTemplates).values({
    id, userId, name: body.name, promptText: body.promptText, suggestedMode: body.suggestedMode,
    description: body.description ?? null,
    ...recipeColumns(body),
    createdAt: now, updatedAt: now,
  })
  const row = await db.select().from(customTemplates).where(eq(customTemplates.id, id)).get()
  return c.json(templateJson(userId, row!), 201)
})

templatesRouter.patch('/:id', zValidator('json', templateBody.partial()), async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = c.req.valid('json')
  const existing = await db.select().from(customTemplates)
    .where(and(eq(customTemplates.id, id), eq(customTemplates.userId, userId))).get()
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const { name, promptText, suggestedMode, description } = body
  await db.update(customTemplates).set({ name, promptText, suggestedMode, description, ...recipeColumns(body), updatedAt: new Date() })
    .where(eq(customTemplates.id, id))
  const row = await db.select().from(customTemplates).where(eq(customTemplates.id, id)).get()
  return c.json(templateJson(userId, row!))
})

templatesRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = await db.select().from(customTemplates)
    .where(and(eq(customTemplates.id, id), eq(customTemplates.userId, userId))).get()
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.delete(customTemplates).where(eq(customTemplates.id, id))
  return c.json({ ok: true })
})
