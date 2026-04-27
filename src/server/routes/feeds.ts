import { Hono } from 'hono'
import { authMiddleware, type AppEnv } from '../middleware/auth.ts'
import { FEED_CATALOG } from '../lib/rss.ts'

export const feedsRouter = new Hono<AppEnv>()

feedsRouter.use('*', authMiddleware)

feedsRouter.get('/', (c) => c.json(FEED_CATALOG))
