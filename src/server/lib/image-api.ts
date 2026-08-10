import { IMAGE_API, IMAGE_CFG_SCALE, IMAGE_TIMEOUT_MS, type ImageApi } from './image-store.ts'

/** Request/response dialects for diffusion servers.
 *
 *  Two exist because the OpenAI image schema cannot express a step count or a seed: servers that
 *  implement it faithfully drop both fields, so every render used their own defaults. The A1111
 *  `/sdapi` shape carries them as first-class fields. Callers pass resolved values — steps and seed
 *  are never optional here, precisely because "unset" is what silently handed control to the
 *  server. */
export interface ImageRequest {
  prompt: string
  steps: number
  seed: number
  /** "512x512". Mapped to whatever the backend wants; omitted means the server's default. */
  size?: string
  negativePrompt?: string
}

export interface EditRequest extends ImageRequest {
  image: Buffer
  /** 0 = unchanged, 1 = ignore the source entirely. */
  strength?: number
}

/** Returns raw PNG bytes. Provenance marking and storage belong to the caller
 *  (`saveGeneratedImage`), so a backend cannot forget them. */
export interface ImageBackend {
  readonly name: ImageApi
  generate(req: ImageRequest): Promise<Uint8Array>
  edit(req: EditRequest): Promise<Uint8Array>
}

/** Thrown for a reachable server that refused or returned nothing usable. The tools turn this into
 *  a `{ success: false }` result so the model can tell the user, rather than failing the turn. */
export class ImageBackendError extends Error {}

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))

function parseSize(size: string | undefined): { width: number; height: number } | null {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size?.trim() ?? '')
  if (!m) return null
  return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) }
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  })
  if (!res.ok) throw new ImageBackendError(`Image server returned ${res.status}`)
  return await res.json() as Record<string, unknown>
}

/** Portable but lossy: `steps` and `seed` are outside the OpenAI image schema, so many servers
 *  ignore them. Sent anyway — those that do accept them cost nothing, and dropping them would make
 *  this backend strictly worse than before. */
function openaiBackend(baseUrl: string): ImageBackend {
  const image = (json: Record<string, unknown>) => {
    const b64 = (json.data as Array<{ b64_json?: string }> | undefined)?.[0]?.b64_json
    if (!b64) throw new ImageBackendError('No image data in response')
    return decode(b64)
  }
  /** No negative-prompt field exists here, so it goes back into the prompt as a phrase — which is
   *  where it used to live before the model was asked to separate it out. Weaker than a real
   *  negative prompt, but better than dropping what the user asked to avoid. */
  const merge = (prompt: string, negativePrompt?: string) =>
    negativePrompt ? `${prompt} Avoid: ${negativePrompt}.` : prompt
  return {
    name: 'openai',
    async generate({ prompt, steps, seed, size, negativePrompt }) {
      const body: Record<string, unknown> = {
        prompt: merge(prompt, negativePrompt), n: 1, response_format: 'b64_json', steps, seed,
      }
      if (size) body.size = size
      if (process.env.IMAGE_MODEL) body.model = process.env.IMAGE_MODEL
      return image(await postJson(`${baseUrl}/v1/images/generations`, body))
    },
    async edit({ image: source, prompt, steps, seed, size, strength, negativePrompt }) {
      const form = new FormData()
      form.append('image', new Blob([source as BlobPart], { type: 'image/png' }), 'image.png')
      form.append('prompt', merge(prompt, negativePrompt))
      form.append('n', '1')
      form.append('response_format', 'b64_json')
      form.append('steps', String(steps))
      form.append('seed', String(seed))
      form.append('strength', String(strength ?? DEFAULT_EDIT_STRENGTH))
      if (size) form.append('size', size)
      if (process.env.IMAGE_MODEL) form.append('model', process.env.IMAGE_MODEL)
      const res = await fetch(`${baseUrl}/v1/images/edits`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      })
      if (!res.ok) throw new ImageBackendError(`Image server returned ${res.status}`)
      return image(await res.json() as Record<string, unknown>)
    },
  }
}

/** A1111's own img2img default. High: it re-noises three-quarters of the image, so a request that
 *  only names one detail still redraws the surroundings. Tools are told to set this explicitly. */
export const DEFAULT_EDIT_STRENGTH = 0.75

/** Below this, step compensation would ask for an absurd count; the render is a light touch-up
 *  anyway, so a few real steps is the honest ceiling. */
const MIN_COMPENSATED_STRENGTH = 0.15

/** Steps to send for an img2img edit so that the *effective* count matches the configured tier.
 *
 *  A diffusion server runs `steps × strength` actual denoising steps on an edit, so a light change
 *  at the draft tier would run one or two and come out rough — measured: strength 0.0 and 0.1 gave
 *  byte-identical output, both hitting the one-step floor. Scaling up costs nothing, because the
 *  work done is still `steps × strength`; it only stops a low strength from starving the render. */
export function compensateSteps(steps: number, strength: number): number {
  return Math.ceil(steps / Math.max(strength, MIN_COMPENSATED_STRENGTH))
}

/** A1111-compatible. Steps and seed are honoured here, which is the whole reason this exists. */
function sdapiBackend(baseUrl: string): ImageBackend {
  const image = (json: Record<string, unknown>) => {
    const b64 = (json.images as string[] | undefined)?.[0]
    if (!b64) throw new ImageBackendError('No image data in response')
    return decode(b64)
  }
  const common = ({ prompt, steps, seed, size, negativePrompt }: ImageRequest) => {
    const body: Record<string, unknown> = { prompt, steps, seed, batch_size: 1 }
    if (negativePrompt) body.negative_prompt = negativePrompt
    if (IMAGE_CFG_SCALE !== undefined) body.cfg_scale = IMAGE_CFG_SCALE
    // A1111 selects a checkpoint through override_settings, not a top-level `model` field.
    if (process.env.IMAGE_MODEL) {
      body.override_settings = { sd_model_checkpoint: process.env.IMAGE_MODEL }
    }
    const parsed = parseSize(size)
    if (parsed) Object.assign(body, parsed)
    return body
  }
  return {
    name: 'sdapi',
    async generate(req) {
      return image(await postJson(`${baseUrl}/sdapi/v1/txt2img`, common(req)))
    },
    async edit(req) {
      const strength = req.strength ?? DEFAULT_EDIT_STRENGTH
      const body = common(req)
      body.init_images = [Buffer.from(req.image).toString('base64')]
      body.denoising_strength = strength
      body.steps = compensateSteps(req.steps, strength)
      return image(await postJson(`${baseUrl}/sdapi/v1/img2img`, body))
    },
  }
}

let cached: ImageBackend | null = null

/** The configured backend. Memoised because it is stateless and picked from the environment. */
export function imageBackend(baseUrl: string): ImageBackend {
  if (!cached || cached.name !== IMAGE_API) {
    cached = IMAGE_API === 'sdapi' ? sdapiBackend(baseUrl) : openaiBackend(baseUrl)
  }
  return cached
}

export const _test = { parseSize, openaiBackend, sdapiBackend }
