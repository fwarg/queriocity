import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { rateLimitByUser, imageLimiter } from '../lib/rate-limit.ts'
import { IMAGE_CREATOR_TOOL, randomSeed, resolveSteps } from '../lib/image-store.ts'
import { imageBackend } from '../lib/image-api.ts'
import { markPng } from '../../shared/ai-provenance.ts'

const generateSchema = z.object({
  prompt: z.string().min(1),
  size: z.string().optional(),
  steps: z.number().int().optional(),
  seed: z.number().int().optional(),
})

export const imagesRouter = new Hono<AppEnv>()

imagesRouter.use('*', authMiddleware)

imagesRouter.post('/generate', rateLimitByUser(imageLimiter, 'image'), zValidator('json', generateSchema), async (c) => {
  const imageBaseUrl = process.env.IMAGE_BASE_URL?.trim()
  if (!imageBaseUrl) return c.json({ error: 'Image generation not configured' }, 503)

  const { prompt, size, steps, seed } = c.req.valid('json')

  try {
    const bytes = await imageBackend(imageBaseUrl).generate({
      prompt, size, steps: resolveSteps(undefined, steps), seed: seed ?? randomSeed(),
    })
    // Marked here rather than at the call site: this endpoint hands raw bytes to the client, so it
    // would otherwise be an unmarked route around the image tools in chat.ts.
    const marked = markPng(bytes, IMAGE_CREATOR_TOOL, process.env.IMAGE_MODEL)
    return c.json({ data: Buffer.from(marked).toString('base64') })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
  }
})
