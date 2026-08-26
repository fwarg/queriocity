import { embed } from 'ai'
import { getEmbeddingModel, EMBED_MAX_INPUT_CHARS, SMALL_MODEL_INPUT_CHARS } from './llm.ts'
import { IMAGE_API } from './image-store.ts'
import { LARGEST_CHUNK_CHARS } from './files/ingest.ts'
import { remoteModelEndpoints } from './space-lock.ts'
import { getAppSetting } from './db.ts'

// The value printed in the README's env example — a live deployment using it has an
// effectively public signing key.
const PLACEHOLDER_SECRETS = ['change-me-in-production-32chars!!', 'changeme', 'secret']

/** Warns rather than exits: a running deployment shouldn't refuse to start after an upgrade
 *  because of a setting that was already in place. Every finding here is silent otherwise —
 *  it surfaces as a bad answer or a failed request much later. */
export function validateConfig(): void {
  const warn = (msg: string) => console.warn(`  [config] ${msg}`)

  const secret = process.env.JWT_SECRET ?? ''
  if (PLACEHOLDER_SECRETS.includes(secret)) {
    warn('JWT_SECRET is a documentation placeholder — anyone can forge a session cookie. Generate one with: openssl rand -base64 32')
  } else if (secret.length < 32) {
    warn(`JWT_SECRET is only ${secret.length} characters; use at least 32 (openssl rand -base64 32)`)
  }

  if (!process.env.CONTEXT_TOKEN_LIMIT) {
    warn('CONTEXT_TOKEN_LIMIT is unset, defaulting to 8192 — conversation history will be over-trimmed on any modern model. Set it to your chat model\'s real context window.')
  }
  if (!process.env.SMALL_MODEL_CONTEXT_TOKENS) {
    warn('SMALL_MODEL_CONTEXT_TOKENS is unset, defaulting to 4096 — set it to the small model\'s real context, or summarisation calls may overflow it.')
  }
  if (process.env.ALLOWED_ORIGIN === '*') {
    warn('ALLOWED_ORIGIN=* allows any website to call this API with the user\'s cookie. Unset it for same-origin only.')
  }
  if (process.env.COOKIE_SECURE === 'false') {
    warn('COOKIE_SECURE=false — the session cookie is sent over plain http. Intended for local development only.')
  }
  if (process.env.SEARCH_API_PROVIDER && process.env.SEARCH_API_KEY && !process.env.SEARCH_MAJOR_ENGINES) {
    warn('SEARCH_MAJOR_ENGINES is unset, so the keyed search API only tops up on a low result count — not when a niche engine alone returns a full page of unrelated hits. List your broad engines (e.g. duckduckgo,brave,startpage) to enable that.')
  }
  if (process.env.IMAGE_BASE_URL && IMAGE_API === 'openai') {
    warn('IMAGE_API is openai — the OpenAI image schema has no step-count or seed field, so servers drop both and the quality tiers do nothing. Set IMAGE_API=sdapi if your server exposes /sdapi/v1/txt2img.')
  }
  const rawApi = process.env.IMAGE_API?.trim().toLowerCase()
  if (rawApi && rawApi !== 'openai' && rawApi !== 'sdapi') {
    warn(`IMAGE_API="${process.env.IMAGE_API}" is not recognised; falling back to openai. Valid values: openai, sdapi.`)
  }

  // Advisory: only matters once a space is locked, but reported at startup so it is known before
  // someone trusts a lock. A locked space removes the model's tools; it cannot un-send the document
  // to a hosted model endpoint.
  const remote = remoteModelEndpoints()
  if (remote.length) {
    warn(`Model endpoints are not local (${remote.join(', ')}) — locked spaces still send documents there, so they isolate from web search but not from the model host.`)
  }

  // The one way the embedding settings can quietly corrupt data rather than merely slow things
  // down: if the per-vector bound falls below the largest chunk this app stores, every long chunk
  // is embedded from its first N characters while the *full* text is still returned as the search
  // result. Retrieval then degrades in a way nothing else reports.
  if (EMBED_MAX_INPUT_CHARS < LARGEST_CHUNK_CHARS) {
    warn(`Embedding input is capped at ${EMBED_MAX_INPUT_CHARS} chars, below the ${LARGEST_CHUNK_CHARS}-char chunks stored for uploaded documents — their vectors are built from truncated text. Raise EMBED_CONTEXT_TOKENS (currently ${process.env.EMBED_CONTEXT_TOKENS ?? '1024'}), which also raises this bound.`)
  }

  const rawGuard = process.env.EGRESS_GUARD?.trim().toLowerCase()
  if (rawGuard && !['enforce', 'log', 'off'].includes(rawGuard)) {
    warn(`EGRESS_GUARD="${process.env.EGRESS_GUARD}" is not recognised; falling back to enforce. Valid values: enforce, log, off.`)
  } else if (rawGuard === 'off') {
    warn('EGRESS_GUARD=off — fetch_url URLs and web_search queries are not screened, so nothing checks whether the model is sending your documents somewhere.')
  }

  if (process.env.FETCH_ALLOW_PRIVATE_HOSTS === 'true' && !process.env.FETCH_PROXY_URL) {
    warn('FETCH_ALLOW_PRIVATE_HOSTS=true — URL fetching can reach loopback and LAN addresses, including from a link planted in a page the model reads.')
  }
}

/** Warns when the attachment size admins can set exceeds what the pipeline behind it can take.
 *
 *  `attachment_chars` decides how much of a file is inlined into the user's message, and admits up
 *  to 500000. That message then reaches four consumers with far smaller, unrelated ceilings — the
 *  query embedding, the memory extractor, the follow-up-question endpoint, and chat indexing. Each
 *  now clamps rather than failing, so nothing breaks; this exists so a large attachment does not
 *  silently mean "most of it was never embedded or remembered".
 *
 *  Async and reading an Admin setting, so it runs with the preflight rather than validateConfig. */
export async function checkAttachmentBudget(): Promise<void> {
  const attachmentChars = parseInt(await getAppSetting('attachment_chars', '20000'), 10) || 20000
  const extractChars = Math.min(
    parseInt(await getAppSetting('memory_extract_chars', '6000'), 10) || 6000,
    SMALL_MODEL_INPUT_CHARS,
  )
  if (attachmentChars <= Math.max(EMBED_MAX_INPUT_CHARS, extractChars)) return
  console.warn(
    `  [config] attachment_chars is ${attachmentChars}, above what the pipeline behind it uses: ` +
    `retrieval embeds the first ${EMBED_MAX_INPUT_CHARS} chars of a message (EMBED_MAX_INPUT_CHARS) and ` +
    `memory extraction reads the last ${extractChars} (memory_extract_chars, capped by ` +
    `SMALL_MODEL_CONTEXT_TOKENS). The full text still reaches the chat model; only these two are trimmed.`
  )
}

/** Confirms EMBED_DIMENSIONS matches what the embedding endpoint actually returns — a
 *  mismatch corrupts every stored vector and only shows up as poor retrieval. */
export async function checkEmbeddingDimensions(): Promise<void> {
  const configured = parseInt(process.env.EMBED_DIMENSIONS ?? '1536', 10)
  try {
    const { embedding } = await embed({ model: getEmbeddingModel(), value: 'dimension check' })
    if (embedding.length !== configured) {
      console.warn(`  [config] EMBED_DIMENSIONS is ${configured} but ${process.env.EMBED_MODEL ?? 'the embedding model'} returns ${embedding.length}. Set EMBED_DIMENSIONS=${embedding.length}; existing vectors are then rebuilt from stored chunk text at the next start, and no resource is lost.`)
    } else {
      console.log(`  [preflight] embeddings OK (${embedding.length} dims)`)
    }
  } catch {
    console.warn('  [preflight] embedding model unreachable — could not verify EMBED_DIMENSIONS')
  }
}
