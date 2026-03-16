import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { signToken } from '../lib/auth.ts'
import { randomUUID } from 'crypto'

// Minimal anonymous-session auth: POST /api/auth/session returns a JWT.
// Replace with real user management as needed.

export const authRouter = new Hono()

const sessionSchema = z.object({
  userId: z.string().optional(),
})

authRouter.post('/session', zValidator('json', sessionSchema), async (c) => {
  const { userId } = c.req.valid('json')
  const id = userId ?? randomUUID()
  const token = await signToken(id)
  return c.json({ token, userId: id })
})
