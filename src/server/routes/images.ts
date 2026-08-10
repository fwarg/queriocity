import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { rateLimitByUser, imageLimiter } from '../lib/rate-limit.ts'
import { IMAGE_CREATOR_TOOL, IMAGE_TIMEOUT_MS, randomSeed, resolveSteps } from '../lib/image-store.ts'
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
  // Seeded explicitly for the same reason as the chat tools: an unset seed is a fixed constant on
  // some servers, which would make repeat renders of one prompt identical.
  // Steps and seed are always sent: an omitted field means the diffusion server's own default,
  // which ignores the configured tiers and, for the seed, is a constant on some servers.
  const body: Record<string, unknown> = {
    prompt, n: 1, response_format: 'b64_json',
    seed: seed ?? randomSeed(),
    steps: resolveSteps(undefined, steps),
  }
  if (size) body.size = size
  if (process.env.IMAGE_MODEL) body.model = process.env.IMAGE_MODEL

  let res: Response
  try {
    res = await fetch(`${imageBaseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    })
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError'
      ? `Image server did not respond within ${Math.round(IMAGE_TIMEOUT_MS / 1000)}s`
      : `Image server unreachable: ${e instanceof Error ? e.message : e}`
    return c.json({ error: msg }, 502)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return c.json({ error: `Diffusion server error: ${res.status} ${text}`.trim() }, 502)
  }

  const json = await res.json()
  const b64 = json.data?.[0]?.b64_json
  if (!b64) return c.json({ error: 'No image data in response' }, 502)

  // Marked here rather than at the call site: this endpoint hands raw bytes to the client, so it
  // would otherwise be an unmarked route around the image tools in chat.ts.
  const marked = markPng(Buffer.from(b64, 'base64'), IMAGE_CREATOR_TOOL, process.env.IMAGE_MODEL)
  return c.json({ data: Buffer.from(marked).toString('base64') })
})
