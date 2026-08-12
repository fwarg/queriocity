import { describe, test, expect } from 'bun:test'
import { stepCount, randomSeed, resolveSteps, imageFilePath, IMAGE_STEPS, IMAGE_STORAGE_DIR } from './image-store.ts'

// These values are forwarded to the diffusion server, so a bad env var must not become a remote
// error that reads as "the image server is broken".
describe('stepCount', () => {
  test('takes a valid count', () => {
    expect(stepCount('8', 15)).toBe(8)
  })

  test('falls back when unset, empty or not a number', () => {
    expect(stepCount(undefined, 15)).toBe(15)
    expect(stepCount('', 15)).toBe(15)
    expect(stepCount('lots', 15)).toBe(15)
  })

  // A model finishing in zero steps is not a meaningful request, and some servers hang on it.
  test('falls back on zero and negatives', () => {
    expect(stepCount('0', 15)).toBe(15)
    expect(stepCount('-4', 15)).toBe(15)
  })
})

test('IMAGE_STEPS defaults ascend across the quality tiers', () => {
  expect(IMAGE_STEPS.draft).toBeLessThan(IMAGE_STEPS.balanced)
  expect(IMAGE_STEPS.balanced).toBeLessThan(IMAGE_STEPS.high)
})

// The whole point is that a render never falls through to the diffusion server's own default,
// which would ignore the configured tiers.
describe('resolveSteps', () => {
  test('maps each quality tier to its configured count', () => {
    expect(resolveSteps('draft', undefined)).toBe(IMAGE_STEPS.draft)
    expect(resolveSteps('balanced', undefined)).toBe(IMAGE_STEPS.balanced)
    expect(resolveSteps('high', undefined)).toBe(IMAGE_STEPS.high)
  })

  test('falls back to balanced when the model names no tier', () => {
    expect(resolveSteps(undefined, undefined)).toBe(IMAGE_STEPS.balanced)
  })

  test('an explicit count wins over the tier', () => {
    expect(resolveSteps('draft', 33)).toBe(33)
  })

  test('ignores a nonsensical explicit count', () => {
    expect(resolveSteps('high', 0)).toBe(IMAGE_STEPS.high)
    expect(resolveSteps(undefined, -1)).toBe(IMAGE_STEPS.balanced)
  })
})

// Signed, not unsigned: a value above 2^31-1 parses as negative on the server, which means
// "randomise" — so half of all seeds were being discarded and renders could not be reproduced.
test('randomSeed stays inside the signed 32-bit range and varies', () => {
  const seeds = Array.from({ length: 200 }, randomSeed)
  expect(seeds.every(s => Number.isInteger(s) && s >= 0 && s <= 0x7fffffff)).toBe(true)
  expect(new Set(seeds).size).toBeGreaterThan(1)
})

/** `edit_image` used `image_url.startsWith('/images/<uid>/')` and then read
 *  `IMAGE_STORAGE_DIR + url.slice(8)`, so a `..` segment passed the check and the file was read and
 *  POSTed to the diffusion server — arbitrary local file read with egress attached. */
describe('imageFilePath', () => {
  const UID = 'user-1'

  test('resolves one of the user\'s own images', () => {
    expect(imageFilePath(UID, `/images/${UID}/abc-123.png`))
      .toBe(`${IMAGE_STORAGE_DIR}/${UID}/abc-123.png`)
  })

  test('refuses traversal that a prefix check would have accepted', () => {
    for (const url of [
      `/images/${UID}/../../../etc/passwd`,
      `/images/${UID}/../other-user/secret.png`,
      `/images/${UID}/..%2f..%2fetc%2fpasswd`,
      `/images/${UID}/sub/dir/x.png`,
    ]) {
      expect(url.startsWith(`/images/${UID}/`)).toBe(true)  // the old check passed every one
      expect(imageFilePath(UID, url)).toBeNull()
    }
  })

  test('refuses another user\'s image, and anything that is not an image URL', () => {
    expect(imageFilePath(UID, '/images/user-2/abc.png')).toBeNull()
    expect(imageFilePath(UID, '/uploads/user-1/abc.png')).toBeNull()
    expect(imageFilePath(UID, `/images/${UID}/abc.txt`)).toBeNull()
    expect(imageFilePath(UID, `/images/${UID}/abc.png?x=1`)).toBeNull()
  })
})
