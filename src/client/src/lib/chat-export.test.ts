import { describe, test, expect } from 'bun:test'
import { sessionMarkdown } from './chat-export.ts'
import type { Message } from './api.ts'

const chat: Message[] = [
  { role: 'user', content: 'Why do bees swarm?' },
  { role: 'assistant', content: 'To split the colony [1].', sources: [{ title: 'Swarming', url: 'https://example.com/swarm' }] },
  { role: 'user', content: 'When?' },
  { role: 'assistant', content: 'In late spring.' },
]

describe('sessionMarkdown', () => {
  test('opens with the AI provenance front-matter and the title', () => {
    const md = sessionMarkdown(chat, 'Bees', 'full')
    expect(md.startsWith('---\ngenerator: Queriocity\nai_generated: true\n')).toBe(true)
    expect(md).toContain('# Bees\n')
  })

  test('links each citation to its numbered source', () => {
    const md = sessionMarkdown(chat, 'Bees', 'full')
    expect(md).toContain('To split the colony [\\[1\\]](#ref-1-1).')
    expect(md).toContain('1. <a id="ref-1-1"></a>[Swarming](https://example.com/swarm)')
  })

  test('the last-answer scope keeps only the final assistant turn', () => {
    const md = sessionMarkdown(chat, 'Bees', 'last')
    expect(md).toContain('In late spring.')
    expect(md).not.toContain('Why do bees swarm?')
    expect(md).not.toContain('To split the colony')
  })
})
