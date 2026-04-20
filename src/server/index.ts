import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from 'hono/bun'
import { chatRouter } from './routes/chat.ts'
import { filesRouter } from './routes/files.ts'
import { historyRouter } from './routes/history.ts'
import { spacesRouter } from './routes/spaces.ts'
import { authRouter } from './routes/auth.ts'
import { adminRouter } from './routes/admin.ts'
import { usersRouter } from './routes/users.ts'
import { memoriesRouter } from './routes/memories.ts'
import { imagesRouter } from './routes/images.ts'
import { sqlite, getAppSetting, setAppSetting } from './lib/db.ts'
import { runDream } from './lib/memory.ts'

const app = new Hono()

app.use('*', logger())
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'
app.use('/api/*', cors({ origin: ALLOWED_ORIGIN, credentials: true }))

app.route('/api/auth', authRouter)
app.route('/api/chat', chatRouter)
app.route('/api/files', filesRouter)
app.route('/api/history', historyRouter)
app.route('/api/spaces', spacesRouter)
app.route('/api/spaces', memoriesRouter)
app.route('/api/admin', adminRouter)
app.route('/api/users', usersRouter)
app.route('/api/images', imagesRouter)

// Serve built client in production
app.use('*', serveStatic({ root: './dist/client' }))
app.get('*', serveStatic({ path: './dist/client/index.html' }))

const PORT = parseInt(process.env.PORT ?? '3000')
console.log(`queriocity listening on http://localhost:${PORT}`)
const _baseURL = process.env.BASE_URL
const _defaultProvider = process.env.BASE_PROVIDER ?? 'openai'
const _defaultBase = _baseURL ?? 'http://localhost:11434/api'
console.log(`  chat:   ${process.env.CHAT_PROVIDER ?? _defaultProvider}  ${process.env.CHAT_BASE_URL ?? _defaultBase}  model=${process.env.CHAT_MODEL ?? 'llama3.2'}`)
console.log(`  small:  ${process.env.SMALL_PROVIDER ?? process.env.CHAT_PROVIDER ?? _defaultProvider}  ${process.env.SMALL_BASE_URL ?? process.env.CHAT_BASE_URL ?? _defaultBase}  model=${process.env.SMALL_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2'}`)
console.log(`  thinking: ${process.env.THINKING_PROVIDER ?? process.env.CHAT_PROVIDER ?? _defaultProvider}  ${process.env.THINKING_BASE_URL ?? process.env.CHAT_BASE_URL ?? _defaultBase}  model=${process.env.THINKING_MODEL ?? process.env.CHAT_MODEL ?? 'llama3.2'}`)
console.log(`  embed:  ${process.env.EMBED_PROVIDER ?? process.env.CHAT_PROVIDER ?? _defaultProvider}  ${process.env.EMBED_BASE_URL ?? process.env.CHAT_BASE_URL ?? _defaultBase}  model=${process.env.EMBED_MODEL ?? 'nomic-embed-text'}  dims=${process.env.EMBED_DIMENSIONS ?? '1536'}`)
console.log(`  searxng: ${process.env.SEARXNG_URL ?? 'http://localhost:4000'}`)
if (process.env.IMAGE_BASE_URL) {
  console.log(`  image:  ${process.env.IMAGE_BASE_URL}  model=${process.env.IMAGE_MODEL ?? 'default'}`)
}

function shutdown() {
  try { sqlite.close() } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function preflight() {
  const searxngUrl = process.env.SEARXNG_URL ?? 'http://localhost:4000'
  try {
    const res = await fetch(`${searxngUrl}/healthz`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) console.log(`  [preflight] searxng OK`)
    else console.warn(`  [preflight] searxng returned ${res.status} — search may not work`)
  } catch {
    console.warn(`  [preflight] searxng unreachable at ${searxngUrl} — search will fail`)
  }

  const chatBase = process.env.CHAT_BASE_URL ?? process.env.BASE_URL ?? 'http://localhost:11434/api'
  try {
    const res = await fetch(chatBase, { signal: AbortSignal.timeout(3000) })
    if (res.status < 500) console.log(`  [preflight] chat LLM OK`)
    else console.warn(`  [preflight] chat LLM at ${chatBase} returned ${res.status}`)
  } catch {
    console.warn(`  [preflight] chat LLM unreachable at ${chatBase} — chat will fail`)
  }
}

preflight().catch(() => {})

setInterval(async () => {
  const hour = parseInt(await getAppSetting('dream_hour', '-1'))
  if (hour < 0) return
  const now = new Date()
  if (now.getHours() !== hour) return
  const todayKey = now.toISOString().split('T')[0]
  const lastRun = await getAppSetting('dream_last_run', '')
  if (lastRun === todayKey) return
  await setAppSetting('dream_last_run', todayKey)
  console.log(`  [dream] starting nightly compaction`)
  runDream().catch(e => console.error('[dream] failed:', e))
}, 5 * 60 * 1000)

export default { port: PORT, fetch: app.fetch, idleTimeout: 255 }
