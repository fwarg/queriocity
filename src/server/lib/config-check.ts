import { embed } from 'ai'
import { getEmbeddingModel } from './llm.ts'
import { IMAGE_API } from './image-store.ts'

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

  if (process.env.FETCH_ALLOW_PRIVATE_HOSTS === 'true' && !process.env.FETCH_PROXY_URL) {
    warn('FETCH_ALLOW_PRIVATE_HOSTS=true — URL fetching can reach loopback and LAN addresses, including from a link planted in a page the model reads.')
  }
}

/** Confirms EMBED_DIMENSIONS matches what the embedding endpoint actually returns — a
 *  mismatch corrupts every stored vector and only shows up as poor retrieval. */
export async function checkEmbeddingDimensions(): Promise<void> {
  const configured = parseInt(process.env.EMBED_DIMENSIONS ?? '1536', 10)
  try {
    const { embedding } = await embed({ model: getEmbeddingModel(), value: 'dimension check' })
    if (embedding.length !== configured) {
      console.warn(`  [config] EMBED_DIMENSIONS is ${configured} but ${process.env.EMBED_MODEL ?? 'the embedding model'} returns ${embedding.length}. Set EMBED_DIMENSIONS=${embedding.length} (existing embeddings must be rebuilt — see ALLOW_EMBED_RESET).`)
    } else {
      console.log(`  [preflight] embeddings OK (${embedding.length} dims)`)
    }
  } catch {
    console.warn('  [preflight] embedding model unreachable — could not verify EMBED_DIMENSIONS')
  }
}
