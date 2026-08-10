import { describe, test, expect, afterEach } from 'bun:test'
import { _test, ImageBackendError, compensateSteps, DEFAULT_EDIT_STRENGTH, type ImageRequest } from './image-api.ts'

const { parseSize, openaiBackend, sdapiBackend } = _test

// A 1x1 PNG, so the decoded bytes are checkable.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; delete process.env.IMAGE_MODEL })

/** Capture the outgoing request instead of making one. */
function captureFetch(response: unknown) {
  const calls: Array<{ url: string; body: unknown; form?: FormData }> = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = init.body
    calls.push(body instanceof FormData
      ? { url: String(url), body: undefined, form: body }
      : { url: String(url), body: JSON.parse(String(body)) })
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return calls
}

const req: ImageRequest = { prompt: 'a wolf', steps: 5, seed: 4242, size: '512x384' }

describe('parseSize', () => {
  test('splits WxH', () => {
    expect(parseSize('1024x576')).toEqual({ width: 1024, height: 576 })
    expect(parseSize(' 512 × 512 ')).toEqual({ width: 512, height: 512 })
  })

  test('rejects anything else rather than guessing', () => {
    expect(parseSize(undefined)).toBeNull()
    expect(parseSize('large')).toBeNull()
    expect(parseSize('512')).toBeNull()
  })
})

// This is the path every existing deployment uses, so its request must not drift.
describe('openai backend', () => {
  test('posts the OpenAI generation shape', async () => {
    const calls = captureFetch({ data: [{ b64_json: PNG_B64 }] })
    const bytes = await openaiBackend('http://d').generate(req)
    expect(calls[0]!.url).toBe('http://d/v1/images/generations')
    expect(calls[0]!.body).toEqual({
      prompt: 'a wolf', n: 1, response_format: 'b64_json', steps: 5, seed: 4242, size: '512x384',
    })
    expect(bytes.length).toBeGreaterThan(0)
  })

  test('sends an edit as multipart', async () => {
    const calls = captureFetch({ data: [{ b64_json: PNG_B64 }] })
    await openaiBackend('http://d').edit({ ...req, image: Buffer.from([1, 2, 3]), strength: 0.4 })
    expect(calls[0]!.url).toBe('http://d/v1/images/edits')
    expect(calls[0]!.form!.get('strength')).toBe('0.4')
    expect(calls[0]!.form!.get('steps')).toBe('5')
  })

  // There is no negative-prompt field in the OpenAI schema, so dropping it would lose what the
  // user asked to avoid. Folded back into the prompt, which is where it lived before.
  test('folds a negative prompt into the prompt text', async () => {
    const calls = captureFetch({ data: [{ b64_json: PNG_B64 }] })
    await openaiBackend('http://d').generate({ ...req, negativePrompt: 'blurry, text' })
    expect((calls[0]!.body as { prompt: string }).prompt).toBe('a wolf Avoid: blurry, text.')
  })

  test('leaves the prompt alone when there is nothing to avoid', async () => {
    const calls = captureFetch({ data: [{ b64_json: PNG_B64 }] })
    await openaiBackend('http://d').generate(req)
    expect((calls[0]!.body as { prompt: string }).prompt).toBe('a wolf')
  })

  test('reports a missing image rather than returning empty bytes', async () => {
    captureFetch({ data: [] })
    await expect(openaiBackend('http://d').generate(req)).rejects.toThrow(ImageBackendError)
  })
})

describe('sdapi backend', () => {
  test('maps size to width/height and posts to txt2img', async () => {
    const calls = captureFetch({ images: [PNG_B64] })
    await sdapiBackend('http://d').generate(req)
    expect(calls[0]!.url).toBe('http://d/sdapi/v1/txt2img')
    expect(calls[0]!.body).toMatchObject({
      prompt: 'a wolf', steps: 5, seed: 4242, width: 512, height: 384,
    })
  })

  test('omits width/height when the size is unparseable, leaving the server default', async () => {
    const calls = captureFetch({ images: [PNG_B64] })
    await sdapiBackend('http://d').generate({ ...req, size: undefined })
    expect(calls[0]!.body).not.toHaveProperty('width')
  })

  test('maps an edit onto init_images and denoising_strength', async () => {
    const calls = captureFetch({ images: [PNG_B64] })
    await sdapiBackend('http://d').edit({ ...req, image: Buffer.from([1, 2, 3]), strength: 0.4 })
    expect(calls[0]!.url).toBe('http://d/sdapi/v1/img2img')
    expect(calls[0]!.body).toMatchObject({
      denoising_strength: 0.4,
      init_images: [Buffer.from([1, 2, 3]).toString('base64')],
    })
  })

  test('defaults edit strength so the field is never absent', async () => {
    const calls = captureFetch({ images: [PNG_B64] })
    await sdapiBackend('http://d').edit({ ...req, image: Buffer.from([1]) })
    expect((calls[0]!.body as { denoising_strength: number }).denoising_strength).toBe(DEFAULT_EDIT_STRENGTH)
  })

  // A light edit at the configured tier would otherwise run one or two real steps.
  test('scales edit steps so the effective count matches the tier', async () => {
    const calls = captureFetch({ images: [PNG_B64] })
    await sdapiBackend('http://d').edit({ ...req, steps: 8, image: Buffer.from([1]), strength: 0.25 })
    expect((calls[0]!.body as { steps: number }).steps).toBe(32)
  })

  test('leaves generation steps untouched — the multiplier only applies to edits', async () => {
    const calls = captureFetch({ images: [PNG_B64] })
    await sdapiBackend('http://d').generate({ ...req, steps: 8 })
    expect((calls[0]!.body as { steps: number }).steps).toBe(8)
  })

  // A1111 switches checkpoints through override_settings, not a top-level `model`.
  test('passes the model as an override setting', async () => {
    process.env.IMAGE_MODEL = 'FLUX2klein'
    const calls = captureFetch({ images: [PNG_B64] })
    await sdapiBackend('http://d').generate(req)
    expect(calls[0]!.body).toMatchObject({ override_settings: { sd_model_checkpoint: 'FLUX2klein' } })
  })

  test('sends a negative prompt when one is given', async () => {
    const calls = captureFetch({ images: [PNG_B64] })
    await sdapiBackend('http://d').generate({ ...req, negativePrompt: 'blurry' })
    expect(calls[0]!.body).toMatchObject({ negative_prompt: 'blurry' })
  })

  test('surfaces a refusal as a backend error', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(sdapiBackend('http://d').generate(req)).rejects.toThrow('500')
  })
})

describe('compensateSteps', () => {
  test('scales inversely with strength', () => {
    expect(compensateSteps(16, 1)).toBe(16)
    expect(compensateSteps(16, 0.5)).toBe(32)
    expect(compensateSteps(8, 0.25)).toBe(32)
  })

  // Without a floor, a near-zero strength asks for hundreds of steps.
  test('clamps the multiplier at very low strength', () => {
    expect(compensateSteps(16, 0.01)).toBe(compensateSteps(16, 0.15))
    expect(compensateSteps(16, 0)).toBeLessThanOrEqual(107)
  })
})
