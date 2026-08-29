import { describe, test, expect } from 'bun:test'
import { findLeakedToolCall, stripLeakedToolCall, parseLooseArgs } from './leaked-tool-call.ts'

// gemma-4 behind LiteLLM intermittently writes an image-mode tool call as ReAct-JSON text
// instead of emitting a real call — the bug seen on 2026-08-29. These cover recovering the
// arguments and scrubbing the blob from the visible reply.

const ACTIONS = ['generate_image', 'edit_image']

describe('findLeakedToolCall', () => {
  test('recovers a ReAct-JSON blob whose action_input is a Python-dict string', () => {
    const text = `{ "action": "generate_image", "action_input": "{'negative_prompt': 'text, watermark, blurry', 'prompt': 'A photorealistic close-up of a red fox. The fox's fur has frost on its tips.', 'quality': 'draft', 'size': '512x512'}" }`
    const leak = findLeakedToolCall(text, ACTIONS, 'generate_image')
    expect(leak).not.toBeNull()
    expect(leak!.action).toBe('generate_image')
    // Unescaped apostrophe inside the value must survive.
    expect(leak!.input.prompt).toBe("A photorealistic close-up of a red fox. The fox's fur has frost on its tips.")
    expect(leak!.input.negative_prompt).toBe('text, watermark, blurry')
    expect(leak!.input.quality).toBe('draft')
    expect(leak!.input.size).toBe('512x512')
    expect(leak!.source).toBe(text)
  })

  test('recovers a blob with a nested JSON object as action_input', () => {
    const text = `Sure!\n\n{"action": "generate_image", "action_input": {"prompt": "a blue cat", "steps": 30}}`
    const leak = findLeakedToolCall(text, ACTIONS, 'generate_image')
    expect(leak!.action).toBe('generate_image')
    expect(leak!.input.prompt).toBe('a blue cat')
    expect(leak!.input.steps).toBe(30)
  })

  test('recovers a bare argument object via the fallback action', () => {
    const text = `{"prompt": "a red fox in snow", "size": "512x512"}`
    const leak = findLeakedToolCall(text, ACTIONS, 'generate_image')
    expect(leak!.action).toBe('generate_image')
    expect(leak!.input.prompt).toBe('a red fox in snow')
  })

  test('recovers the classic Action / Action Input scaffolding', () => {
    const text = `Thought: I should draw it.\nAction: edit_image\nAction Input: {"image_url": "/images/a/b.png", "prompt": "make it blue", "strength": 0.6}`
    const leak = findLeakedToolCall(text, ACTIONS, 'generate_image')
    expect(leak!.action).toBe('edit_image')
    expect(leak!.input.image_url).toBe('/images/a/b.png')
    expect(leak!.input.strength).toBe(0.6)
  })

  test('returns null for an ordinary reply', () => {
    expect(findLeakedToolCall('Here is a summary of what I found about foxes.', ACTIONS, 'generate_image')).toBeNull()
  })

  test('returns null when the action is not one we accept', () => {
    const text = `{"action": "web_search", "action_input": "{'query': 'foxes'}"}`
    expect(findLeakedToolCall(text, ACTIONS, 'generate_image')).toBeNull()
  })
})

describe('parseLooseArgs', () => {
  test('handles multiple unescaped apostrophes across values', () => {
    const out = parseLooseArgs("{'a': 'it's here', 'b': 'don't stop', 'c': 42}")
    expect(out).toEqual({ a: "it's here", b: "don't stop", c: 42 })
  })
})

describe('stripLeakedToolCall', () => {
  test('removes the exact source slice and surrounding scaffolding', () => {
    const text = `Thought: draw it\n{ "action": "generate_image", "action_input": "{'prompt': 'x'}" }`
    const source = `{ "action": "generate_image", "action_input": "{'prompt': 'x'}" }`
    expect(stripLeakedToolCall(text, source)).toBe('')
  })

  test('keeps a genuine summary sentence that precedes the blob', () => {
    const source = `{"action": "generate_image", "action_input": {"prompt": "x"}}`
    const text = `A fennec fox has oversized ears and pale fur.\n\n${source}`
    expect(stripLeakedToolCall(text, source)).toBe('A fennec fox has oversized ears and pale fur.')
  })

  test('strips a trailing JSON action blob without a known source', () => {
    const text = `Working on it.\n{"action": "generate_image", "action_input": "{'prompt': 'x'}"}`
    expect(stripLeakedToolCall(text)).toBe('Working on it.')
  })

  test('drops the blob and anything after it even when a stale source no longer matches', () => {
    // The model leaked the call, then went on to make a real one and narrate it — the image was
    // still produced, but none of this belongs in the visible reply.
    const text = `{"action": "generate_image", "action_input": {"prompt": "x"}}\nGenerating now...`
    expect(stripLeakedToolCall(text, 'source that is not in the text')).toBe('')
  })
})
