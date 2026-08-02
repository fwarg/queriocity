import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { rateLimitByUser, imageLimiter } from '../lib/rate-limit.ts'
import { IMAGE_TIMEOUT_MS } from '../lib/image-store.ts'

const generateSchema = z.object({
  prompt: z.string().min(1),
  size: z.string().optional(),
  steps: z.number().int().optional(),
})

export const imagesRouter = new Hono<AppEnv>()

imagesRouter.use('*', authMiddleware)

imagesRouter.post('/generate', rateLimitByUser(imageLimiter, 'image'), zValidator('json', generateSchema), async (c) => {
  const imageBaseUrl = process.env.IMAGE_BASE_URL?.trim()
  if (!imageBaseUrl) return c.json({ error: 'Image generation not configured' }, 503)

  const { prompt, size, steps } = c.req.valid('json')
  const body: Record<string, unknown> = { prompt, n: 1, response_format: 'b64_json' }
  if (size) body.size = size
  if (steps) body.steps = steps
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

  return c.json({ data: b64 })
})
