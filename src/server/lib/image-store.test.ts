import { describe, test, expect } from 'bun:test'
import { stepCount, randomSeed, resolveSteps, IMAGE_STEPS } from './image-store.ts'

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

// Diffusion servers take a 32-bit unsigned seed; anything wider is wrapped or rejected.
test('randomSeed stays inside the 32-bit unsigned range and varies', () => {
  const seeds = Array.from({ length: 50 }, randomSeed)
  expect(seeds.every(s => Number.isInteger(s) && s >= 0 && s <= 0xffffffff)).toBe(true)
  expect(new Set(seeds).size).toBeGreaterThan(1)
})
