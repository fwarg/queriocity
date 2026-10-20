import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { streamText, tool, stepCountIs } from 'ai'
import { webSearch, newSearchBudget, type SearchResult, type EngineError, type SearchBudget } from '../search/index.ts'
import { languageModel, modelTarget, researchMaxTokens } from '../llm.ts'
import { ThinkExtractor } from '../think-extractor.ts'
import { findLeakedToolCall, stripLeakedToolCall, coerceNumericArgs, findLeakedImageMarkdown, stripLeakedImageMarkdown } from '../leaked-tool-call.ts'
import { trimMessages, CONTEXT_RESERVE_FRACTION } from '../trim-messages.ts'
import { IMAGE_API, imageFilePath, randomSeed, resolveSteps, saveGeneratedImage } from '../image-store.ts'
import { imageBackend, compensateSteps, DEFAULT_EDIT_STRENGTH } from '../image-api.ts'
import { withKeepalive, type TurnContext, type TurnResult, type TurnSink } from './context.ts'

/** Render settings used for each generated image, so an edit inherits them from its source.
 *
 *  An edit arrives as a follow-up like "change the fur to blue", which restates neither the quality
 *  tier nor the exclusions nor the seed — so without this every edit fell back to defaults, quietly
 *  rendering a draft image at balanced and dropping the negative prompt the generation had set.
 *
 *  Reusing the source's seed also keeps the edit closer to the original: measured over six seeds at
 *  strength 0.65, the source seed gave a mean pixel distance of 42 against 46-56 for random ones.
 *  The seed picks the noise layered onto the source, and the noise the source was built from
 *  disturbs it least.
 *
 *  Kept here rather than asked of the model, which rewrites the positive prompt faithfully and
 *  forgets everything else. Keyed by image URL rather than held per turn, because an edit almost
 *  always arrives as a later request with a fresh closure, and unlike the image URL — recovered by
 *  scanning message history — a tool argument leaves nothing to recover from.
 *
 *  In memory only: after a restart an edit simply falls back to defaults. */
interface RenderSettings {
  negativePrompt?: string
  steps: number
  seed: number
}

const renderByImage = new Map<string, RenderSettings>()
const MAX_REMEMBERED_RENDERS = 500

function rememberRender(url: string | undefined, settings: RenderSettings) {
  if (!url) return
  if (renderByImage.size >= MAX_REMEMBERED_RENDERS) renderByImage.clear()
  renderByImage.set(url, settings)
}

const IMAGE_MD_RE = /!\[.*?\]\((\/images\/[\w-]+\/[\w-]+\.png)\)/g
const isLocalImage = (url: string) => /^\/images\//.test(url)

// Shared by the tool schema and the leaked-call recovery below, which validates a call the
// model wrote as text against the same shape before running it.
const generateImageSchema = z.object({
  prompt: z.string().describe('Detailed visual description for image generation'),
  size: z.string().optional().describe('Image dimensions e.g. "512x512", "1024x1024", "1024x576"'),
  negative_prompt: z.string().optional().describe('What to keep out of the image, comma-separated (e.g. "blurry, text, watermark"). Put anything the user says to avoid here rather than in prompt'),
  quality: z.enum(['draft', 'balanced', 'high']).optional().describe('Quality tier taken from the user\'s wording. Resolved to a step count by the server; prefer this over steps'),
  steps: z.number().int().optional().describe('Explicit step count. Only when the user names a number outright; otherwise leave unset and use quality'),
  seed: z.number().int().optional().describe('Random seed. Only set when the user explicitly asks for a specific seed or to reproduce an earlier image; omit otherwise so the result varies'),
})
const editImageSchema = z.object({
  image_url: z.string().describe('The /images/... URL of the image to edit (from chat history)'),
  prompt: z.string().describe('Full description of the desired result, including unchanged aspects'),
  strength: z.number().min(0).max(1).optional()
    .describe('How much of the image to redraw. 0.3-0.45 to alter or remove a small object; 0.5-0.65 to recolour the main subject, or to change style or lighting; 0.8+ to reimagine it. Colour survives a low-strength pass — the original hue bleeds through — so recolouring needs more than its size suggests. Always set this: the 0.75 default redraws most of the picture.'),
  size: z.string().optional().describe('Output dimensions e.g. "512x512". Defaults to source size.'),
  negative_prompt: z.string().optional().describe('What to keep out of the image, comma-separated (e.g. "blurry, text, watermark"). Put anything the user says to avoid here rather than in prompt'),
  quality: z.enum(['draft', 'balanced', 'high']).optional().describe('Quality tier taken from the user\'s wording. Resolved to a step count by the server; prefer this over steps'),
  steps: z.number().int().optional().describe('Explicit step count. Only when the user names a number outright; otherwise leave unset and use quality'),
  seed: z.number().int().optional().describe('Random seed. Only set when the user explicitly asks for a specific seed or to reproduce an earlier image; omit otherwise so the result varies'),
})

type ToolOutcome = { success: boolean; prompt: string; seed?: number; error?: string }

/** Image turns: a generate_image or edit_image call; any text only after a web_search, as one sentence. */
const imageSystem = (lastGeneratedImageUrl?: string) => `You are an image generation assistant.
- When asked to draw, illustrate, create, or generate an image, call generate_image with a detailed visual prompt.
- When asked to edit, change, or modify a previously generated image, call edit_image.${lastGeneratedImageUrl ? ` The most recently generated image is at ${lastGeneratedImageUrl}.` : ''}
- If the subject is specialized, technical, or you are uncertain what it looks like visually, call web_search first to gather context, then use what you learned to write a richer prompt.
- Extract size from resolution strings, and set quality to draft, balanced or high from wording like "quick sketch", "high quality" or "detailed". Do not convert quality into a step count yourself — pass the word and let the server decide. Use steps only if the user names a number outright.
- Put every exclusion in negative_prompt, never in prompt — both what the user asked to avoid and any boilerplate you would add yourself ("no text", "no watermark", "not blurry"). A diffusion model cannot represent negation inside a prompt, so "no text" there tends to produce text. prompt describes only what should be present.
- On edit_image, choose strength from how much the user asked to change: altering or removing a small object is 0.3-0.45, recolouring the main subject or changing style or lighting is 0.5-0.65, a full reimagining is 0.8+. Recolouring needs a mid strength even though it sounds small — at 0.35 the original colour bleeds through and you get a half-changed result. Leaving it unset redraws most of the image.
- Pass seed only when the user names one, or asks to reuse or reproduce a previous image's seed. Never invent one: omitting it makes each render vary.
- If you used web_search, respond with one sentence summarizing what you learned that shaped the prompt. Otherwise output nothing — do not add any text, URLs, or commentary after the image tool call.
- Never write a markdown image, an image link, or a URL to any image service yourself. The only way to produce an image is the generate_image / edit_image tool; the server inserts the result. A URL you write is not an image and will be removed.
- Always respond in the same language the user used.`

/** One image turn's renders, searches and emitted images. */
class ImageJob {
  pendingImageUrl: string | undefined
  lastGeneratedImageUrl: string | undefined
  readonly sources: SearchResult[] = []
  // Buffered rather than emitted directly — the tools are built before the stream loop runs.
  // Without these the client saw zero sources whether or not image searched, so a blocked engine
  // that the keyed fallback covered still read as "answered without web results".
  readonly pendingSources: SearchResult[] = []
  readonly engineErrors = new Map<string, EngineError>()
  readonly emitted: Array<{ url: string; alt: string }> = []
  sawImageTool = false

  constructor(
    private readonly ctx: TurnContext,
    private readonly sink: TurnSink,
    private readonly baseUrl: string,
    private readonly searchBudget: SearchBudget,
  ) {
    for (const m of ctx.msgs) {
      for (const [, url] of m.content.matchAll(IMAGE_MD_RE)) this.lastGeneratedImageUrl = url
    }
  }

  async generate({ prompt, size, negative_prompt, quality, steps, seed }: z.infer<typeof generateImageSchema>): Promise<ToolOutcome> {
    const usedSeed = seed ?? randomSeed()
    const usedSteps = resolveSteps(quality, steps)
    const origin = quality ?? (steps ? 'explicit' : 'default')
    console.log(`  [image] → ${this.baseUrl} (${IMAGE_API})  prompt="${prompt}"  negative="${negative_prompt ?? ''}"  size=${size ?? 'default'}  steps=${usedSteps} (${origin})  seed=${usedSeed}${seed === undefined ? ' (random)' : ''}`)
    try {
      const bytes = await imageBackend(this.baseUrl).generate({ prompt, size, negativePrompt: negative_prompt, steps: usedSteps, seed: usedSeed })
      await this.saved(bytes, { negativePrompt: negative_prompt, steps: usedSteps, seed: usedSeed })
      return { success: true, prompt, seed: usedSeed }
    } catch (e) {
      console.error(`  [image] error:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e), prompt }
    }
  }

  async edit({ image_url, prompt, strength, size, negative_prompt, quality, steps, seed }: z.infer<typeof editImageSchema>): Promise<ToolOutcome> {
    const imagePath = imageFilePath(this.ctx.userId, image_url)
    if (!imagePath) {
      return { success: false, error: 'Invalid image reference', prompt }
    }
    // Explicit wording in this turn wins; otherwise inherit from the image being edited.
    const source = renderByImage.get(image_url)
    const askedForQuality = quality !== undefined || steps !== undefined
    const usedSteps = askedForQuality ? resolveSteps(quality, steps) : source?.steps ?? resolveSteps(undefined, undefined)
    // Inheriting the seed makes an identical request reproduce the identical image, so a
    // retry has to break out of it — that is the one case where the user wants a new attempt.
    const inheritSeed = !this.ctx.regenerate ? source?.seed : undefined
    const usedSeed = seed ?? inheritSeed ?? randomSeed()
    const usedNegative = negative_prompt ?? source?.negativePrompt
    const stepOrigin = askedForQuality ? (quality ?? 'explicit') : source ? 'inherited' : 'default'
    const seedOrigin = seed !== undefined ? '' : inheritSeed !== undefined ? ' (inherited)' : this.ctx.regenerate ? ' (retry)' : ' (random)'
    // Steps are scaled by 1/strength inside the backend, so report what is actually sent —
    // the tier alone reads like the compensation never happened.
    const sentSteps = IMAGE_API === 'sdapi' ? compensateSteps(usedSteps, strength ?? DEFAULT_EDIT_STRENGTH) : usedSteps
    console.log(`  [image] edit → ${this.baseUrl} (${IMAGE_API})  prompt="${prompt}"  negative="${usedNegative ?? ''}"${negative_prompt === undefined && usedNegative ? ' (carried)' : ''}  strength=${strength ?? DEFAULT_EDIT_STRENGTH}${strength === undefined ? ' (default)' : ''}  steps=${usedSteps} (${stepOrigin}) → ${sentSteps} sent  seed=${usedSeed}${seedOrigin}`)
    try {
      const image = await readFile(imagePath)
      const bytes = await imageBackend(this.baseUrl).edit({ image, prompt, strength, size, negativePrompt: usedNegative, steps: usedSteps, seed: usedSeed })
      await this.saved(bytes, { negativePrompt: usedNegative, steps: usedSteps, seed: usedSeed })
      return { success: true, prompt, seed: usedSeed }
    } catch (e) {
      console.error(`  [image] edit error:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e), prompt }
    }
  }

  private async saved(bytes: Uint8Array, settings: RenderSettings) {
    this.pendingImageUrl = await saveGeneratedImage(this.ctx.userId, bytes)
    this.lastGeneratedImageUrl = this.pendingImageUrl
    rememberRender(this.pendingImageUrl, settings)
  }

  async search(query: string) {
    console.log(`  [image] web_search "${query}"`)
    if (this.searchBudget.queriesRemaining <= 0) return 'The search limit for this request is reached — continue with what you already know.'
    const results = await webSearch(query, 10, undefined, errors => errors.forEach(e => this.engineErrors.set(e.engine, e)), this.searchBudget)
    const seen = new Set(this.sources.map(s => s.url))
    for (const r of results) {
      if (seen.has(r.url)) continue
      seen.add(r.url)
      this.sources.push(r)
      this.pendingSources.push(r)
    }
    return results.map(r => `${r.title}: ${r.content}`).join('\n\n')
  }

  tools() {
    return {
      web_search: tool({
        description: 'Search the web for context about a specialized or unfamiliar subject before generating an image.',
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: ({ query }) => this.search(query),
      }),
      generate_image: tool({
        description: 'Generate an image from a text description using a local diffusion model.',
        inputSchema: generateImageSchema,
        execute: args => this.generate(args),
      }),
      edit_image: tool({
        description: 'Modify a previously generated image. Use when the user asks to change, edit, or iterate on an image.',
        inputSchema: editImageSchema,
        execute: args => this.edit(args),
      }),
    }
  }

  /** Emits the image a successful tool call just rendered. */
  async emitRendered(r: { success?: boolean; prompt?: string }) {
    if (!r.success || !this.pendingImageUrl) return false
    const url = this.pendingImageUrl
    this.pendingImageUrl = undefined
    this.emitted.push({ url, alt: r.prompt ?? '' })
    await this.sink.emit({ type: 'image', url, alt: r.prompt ?? '' })
    return true
  }

  /** Forwards searches buffered by the web_search tool: results, then blocked-engine warnings. */
  async flushSearch() {
    if (this.pendingSources.length) {
      await this.sink.step({ kind: 'results', count: this.pendingSources.length })
      await this.sink.emit({ type: 'sources', sources: this.pendingSources.splice(0) })
    }
    if (this.engineErrors.size) {
      const engines = [...this.engineErrors.values()].map(e => ({ engine: e.engine, reason: e.reason }))
      this.engineErrors.clear()
      await this.sink.emit({ type: 'search_warning', engines })
    }
  }

  get producedImage() {
    return this.sawImageTool || this.emitted.length > 0
  }
}

/** Image mode: the chat model drives generate/edit/search tools, and the rendered images become the answer. */
export async function runImageTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnResult> {
  const baseUrl = process.env.IMAGE_BASE_URL?.trim() || undefined
  if (!baseUrl) {
    const notConfigured = 'Image generation is not configured. Set the IMAGE_BASE_URL environment variable to enable it.'
    await sink.emit({ type: 'text', delta: notConfigured })
    return { content: notConfigured, sources: [], fileSources: [], cacheable: false }
  }
  const t0 = Date.now()
  // Image's search runs through the same plumbing as the other modes: blocked engines reach the
  // user instead of vanishing, and the paid-fallback cap covers this path too.
  const job = new ImageJob(ctx, sink, baseUrl, await newSearchBudget('image'))
  // Diffusion emits nothing until the image is finished, so this stream can go minutes
  // without a byte — far longer than the other modes, which are at worst waiting on a
  // search. Without the ping an idle-timeout upstream reaps the connection mid-generation.
  const content = await withKeepalive(sink, async () => {
    const rawText = await streamImageModel(ctx, sink, job)
    const leak = await recoverLeakedCall(sink, job, rawText)
    await recoverExternalImage(sink, job, rawText)
    // Drop <think>/<tool_call> markup, the leaked tool-call blob and any model-written image
    // markdown, then send what remains — normally a single sentence, or nothing — in one write.
    const thinkExtractor = new ThinkExtractor()
    let visible = thinkExtractor.process(rawText).text + thinkExtractor.flush().text
    visible = stripLeakedToolCall(visible, leak?.source)
    visible = stripLeakedImageMarkdown(visible, isLocalImage)
    if (visible) await sink.emit({ type: 'text', delta: visible })
    let full = visible
    for (const img of job.emitted) full += `${full ? '\n\n' : ''}![${img.alt}](${img.url})`
    return full
  })
  console.log(`  [image] done in ${Date.now() - t0}ms, ${content.length} chars`)
  return { content, sources: job.sources, fileSources: [], cacheable: false }
}

/** Runs the tool loop, emitting progress and images as they land; returns the model's raw text. */
async function streamImageModel(ctx: TurnContext, sink: TurnSink, job: ImageJob): Promise<string> {
  const system = imageSystem(job.lastGeneratedImageUrl)
  // Always the local chat model, not the turn's: a per-request model choice does not apply to image mode.
  const imageModel = modelTarget('chat')
  const history = trimMessages(ctx.msgs, Math.floor(imageModel.contextTokens * CONTEXT_RESERVE_FRACTION), system, ctx.pinned)
  await sink.context(history.report)
  // Not the flash model: this drives a multi-step tool loop with five typed parameters, and
  // with FLASH_MODEL=small that is a small model doing the least reliable thing asked of it —
  // a misparsed size/steps degrades the image with no visible error.
  const result = streamText({
    model: languageModel(imageModel),
    abortSignal: ctx.abortSignal,
    system,
    messages: history.messages,
    tools: job.tools(),
    stopWhen: stepCountIs(4),
    maxOutputTokens: researchMaxTokens(),
  })
  // Image mode's text is buffered rather than streamed delta-by-delta: diffusion blocks the
  // stream for minutes anyway, and the system prompt permits at most one summary sentence — so
  // nothing is lost by holding it, and holding it lets a tool call the model wrote as text
  // (see the recovery below) be scrubbed before the user ever sees it.
  let rawText = ''
  for await (const part of result.stream) {
    if (part.type === 'text-delta') {
      rawText += part.text
    } else if (part.type === 'tool-call') {
      if (part.toolName === 'web_search') {
        const q = (part.input as { query?: string } | undefined)?.query
        await sink.step({ kind: 'search', queries: q ? [q] : [] })
      } else if (part.toolName === 'generate_image') {
        job.sawImageTool = true
        await sink.step({ kind: 'image' })
      } else if (part.toolName === 'edit_image') {
        job.sawImageTool = true
        await sink.step({ kind: 'image', detail: 'Editing image…', detailKey: 'log.imageEdit' })
      }
    } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
      await job.flushSearch()
    } else if (part.type === 'tool-result' && (part.toolName === 'generate_image' || part.toolName === 'edit_image')) {
      await job.emitRendered(part.output as { success?: boolean; prompt?: string })
    }
  }
  return rawText
}

/** gemma-4 behind LiteLLM intermittently answers image mode by writing the tool call into its
 *  text as a LangChain ReAct-JSON blob — `{ "action": "generate_image", "action_input":
 *  "{'prompt': ...}" }` — rather than emitting a real call. The AI SDK never parses that, so
 *  without this the blob is the whole reply and no image is produced. Recover the call from the
 *  text, validate it against the real schema, and run it. */
async function recoverLeakedCall(sink: TurnSink, job: ImageJob, rawText: string) {
  const leak = findLeakedToolCall(rawText, ['generate_image', 'edit_image'], 'generate_image')
  if (!leak || job.producedImage) return leak
  const args = coerceNumericArgs(leak.input, ['steps', 'seed', 'strength'])
  const isEdit = leak.action === 'edit_image'
  const parsed = isEdit ? editImageSchema.safeParse(args) : generateImageSchema.safeParse(args)
  if (!parsed.success) {
    console.warn(`  [image] recovered ${leak.action} args rejected: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`)
    return leak
  }
  await sink.step(isEdit ? { kind: 'image', detail: 'Editing image…', detailKey: 'log.imageEdit' } : { kind: 'image' })
  const r = isEdit
    ? await job.edit(parsed.data as z.infer<typeof editImageSchema>)
    : await job.generate(parsed.data as z.infer<typeof generateImageSchema>)
  if (!await job.emitRendered(r)) console.warn(`  [image] recovered ${leak.action} call failed: ${r.error ?? 'no image'}`)
  return leak
}

/** The other leak shape: the model writes its own markdown image at an external prompt-to-image
 *  service (pollinations.ai and the like) instead of calling the tool. It renders, so it passes
 *  for success, but no local image exists and the note would ship the prompt to a third party on
 *  every view. Re-run the generation from the prompt in the URL. */
async function recoverExternalImage(sink: TurnSink, job: ImageJob, rawText: string) {
  const [leakedImg] = findLeakedImageMarkdown(rawText, isLocalImage)
  if (!leakedImg?.prompt || job.producedImage) return
  console.warn(`  [image] recovered a prompt from a model-written external image URL: ${leakedImg.url.slice(0, 120)}`)
  const parsed = generateImageSchema.safeParse({ prompt: leakedImg.prompt })
  if (!parsed.success) return
  await sink.step({ kind: 'image' })
  const r = await job.generate(parsed.data)
  if (!await job.emitRendered(r)) console.warn(`  [image] recovered external-URL call failed: ${r.error ?? 'no image'}`)
}
