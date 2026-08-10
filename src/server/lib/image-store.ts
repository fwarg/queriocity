import { unlink } from 'node:fs/promises'
import pkg from '../../../package.json' with { type: 'json' }

/** Provenance recorded in every generated image's metadata — EU AI Act Art 50(2). */
export const IMAGE_CREATOR_TOOL = `Queriocity ${pkg.version}`

// Diffusion runs are slow by nature (high step counts, large sizes, a shared GPU), so this
// only catches a genuinely stuck server rather than bounding normal work.
export const IMAGE_TIMEOUT_MS = parseInt(process.env.IMAGE_TIMEOUT_MS ?? '300000', 10)

export const IMAGE_STORAGE_DIR = process.env.IMAGE_STORAGE_DIR ?? '/tmp/queriocity/images'

/** Validated here rather than with a bare parseInt: these reach the diffusion server, and a NaN
 *  or zero produces a confusing remote error rather than an obvious local one. */
export function stepCount(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Inference steps per quality tier. Configurable because the right values are a property of the
 *  model, not of this app: a timestep-distilled model (schnell, turbo, LCM) wants a handful, an
 *  SD1.5-era one wants 25+. Defaults suit a guidance-distilled FLUX-class model.
 *
 *  The server owns these — the quality wording in the prompt template deliberately names no
 *  numbers, so changing the env cannot leave a stale figure in the UI. */
export const IMAGE_STEPS = {
  draft: stepCount(process.env.IMAGE_STEPS_DRAFT, 5),
  balanced: stepCount(process.env.IMAGE_STEPS_BALANCED, 15),
  high: stepCount(process.env.IMAGE_STEPS_HIGH, 25),
}

export type ImageQuality = keyof typeof IMAGE_STEPS

/** Steps for a render, from the quality tier the model picked or an explicit count the user named.
 *
 *  Always resolves to a number, never to "unset": leaving the field out means the diffusion server
 *  applies its own default (20 for stable-diffusion.cpp), which silently ignores the configured
 *  tiers. The model is asked for the quality *word* rather than a count so the numbers stay here,
 *  where they are configurable, instead of depending on the model doing the lookup. */
export function resolveSteps(quality: ImageQuality | undefined, steps: number | undefined): number {
  if (steps !== undefined && steps > 0) return steps
  return IMAGE_STEPS[quality ?? 'balanced']
}

/** Diffusion servers overwhelmingly take a 32-bit unsigned seed; larger values are wrapped or
 *  rejected depending on the implementation. */
const SEED_MAX = 0xffffffff

/** A seed for renders where the user did not pin one.
 *
 *  Sent explicitly rather than left unset, because servers disagree on what unset means:
 *  stable-diffusion.cpp substitutes a constant 42, so the same prompt returned the same image
 *  every time. Generating one here makes repeat renders vary on any backend. */
export const randomSeed = (): number => Math.floor(Math.random() * (SEED_MAX + 1))

const IMAGE_URL_RE = /!\[.*?\]\((\/images\/[\w-]+\/[\w-]+\.png)\)/g

/** Delete any generated image files referenced in the given message contents. */
export async function deleteSessionImages(contents: string[]): Promise<void> {
  const paths = new Set<string>()
  for (const content of contents) {
    for (const [, url] of content.matchAll(IMAGE_URL_RE)) {
      paths.add(`${IMAGE_STORAGE_DIR}/${url.slice('/images/'.length)}`)
    }
  }
  if (paths.size === 0) return
  await Promise.all([...paths].map(p =>
    unlink(p).catch(() => {}) // ignore missing files
  ))
  console.log(`  [image] deleted ${paths.size} file(s) for session`)
}
