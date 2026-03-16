import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from 'hono/bun'
import { chatRouter } from './routes/chat.ts'
import { filesRouter } from './routes/files.ts'
import { historyRouter } from './routes/history.ts'
import { authRouter } from './routes/auth.ts'

const app = new Hono()

app.use('*', logger())
app.use('/api/*', cors())

app.route('/api/auth', authRouter)
app.route('/api/chat', chatRouter)
app.route('/api/files', filesRouter)
app.route('/api/history', historyRouter)

// Serve built client in production
app.use('*', serveStatic({ root: './dist/client' }))
app.get('*', serveStatic({ path: './dist/client/index.html' }))

const PORT = parseInt(process.env.PORT ?? '3000')
console.log(`queriocity listening on http://localhost:${PORT}`)

export default { port: PORT, fetch: app.fetch }
