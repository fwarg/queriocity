import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'

const generateSchema = z.object({
  prompt: z.string().min(1),
  size: z.string().optional(),
  steps: z.number().int().optional(),
})

export const imagesRouter = new Hono<AppEnv>()

imagesRouter.use('*', authMiddleware)

imagesRouter.post('/generate', zValidator('json', generateSchema), async (c) => {
  const imageBaseUrl = process.env.IMAGE_BASE_URL?.trim()
  if (!imageBaseUrl) return c.json({ error: 'Image generation not configured' }, 503)

  const { prompt, size, steps } = c.req.valid('json')
  const body: Record<string, unknown> = { prompt, n: 1, response_format: 'b64_json' }
  if (size) body.size = size
  if (steps) body.steps = steps
  if (process.env.IMAGE_MODEL) body.model = process.env.IMAGE_MODEL

  const res = await fetch(`${imageBaseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return c.json({ error: `Diffusion server error: ${res.status} ${text}`.trim() }, 502)
  }

  const json = await res.json()
  const b64 = json.data?.[0]?.b64_json
  if (!b64) return c.json({ error: 'No image data in response' }, 502)

  return c.json({ data: b64 })
})
