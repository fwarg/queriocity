import { describe, test, expect } from 'bun:test'
import {
  findLeakedToolCall,
  stripLeakedToolCall,
  parseLooseArgs,
  findLeakedImageMarkdown,
  stripLeakedImageMarkdown,
} from './leaked-tool-call.ts'

const isLocal = (url: string) => /^\/images\//.test(url)

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

describe('findLeakedImageMarkdown', () => {
  const pollinations =
    "![A grey wolf on a snowy peak.](https://image.pollinations.ai/prompt/A%20grey%20wolf%20on%20a%20snowy%20peak.%20The%20wolf's%20fur%20is%20thick.&width=512&height=512&nologo=true)"

  test('pulls the prompt out of a pollinations.ai URL, trimming the render options', () => {
    const [leak] = findLeakedImageMarkdown(pollinations, isLocal)
    expect(leak.url).toContain('pollinations.ai')
    expect(leak.prompt).toBe("A grey wolf on a snowy peak. The wolf's fur is thick.")
  })

  test('falls back to alt text when the URL carries no prompt', () => {
    const [leak] = findLeakedImageMarkdown('![a red fox](https://example.com/fox.png)', isLocal)
    expect(leak.prompt).toBe('a red fox')
  })

  test('reads a ?prompt= query param', () => {
    const [leak] = findLeakedImageMarkdown('![x](https://img.test/gen?prompt=blue%20cat&w=512)', isLocal)
    expect(leak.prompt).toBe('blue cat')
  })

  test('ignores our own /images/ paths', () => {
    expect(findLeakedImageMarkdown('![done](/images/abc/def.png)', isLocal)).toEqual([])
  })

  test('finds every external image in the reply', () => {
    const text = '![a](https://a.test/1.png)\n![b](/images/x/y.png)\n![c](https://c.test/2.png)'
    expect(findLeakedImageMarkdown(text, isLocal).map(l => l.url)).toEqual([
      'https://a.test/1.png',
      'https://c.test/2.png',
    ])
  })
})

describe('stripLeakedImageMarkdown', () => {
  test('removes external images but keeps ours and the surrounding prose', () => {
    const text = 'Here you go.\n\n![wolf](https://image.pollinations.ai/prompt/wolf)\n\n![real](/images/x/y.png)'
    expect(stripLeakedImageMarkdown(text, isLocal)).toBe('Here you go.\n\n![real](/images/x/y.png)')
  })

  test('collapses to empty when the whole reply was a leaked image', () => {
    expect(stripLeakedImageMarkdown('![x](https://pollinations.ai/p/x)', isLocal)).toBe('')
  })
})
