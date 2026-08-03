import { describe, test, expect } from 'bun:test'
import { ollamaOpenAIBase } from './llm.ts'

describe('ollamaOpenAIBase', () => {
  test('rewrites the native /api path to the OpenAI-compatible /v1', () => {
    expect(ollamaOpenAIBase('http://localhost:11434/api')).toBe('http://localhost:11434/v1')
  })

  test('appends /v1 to a bare host', () => {
    expect(ollamaOpenAIBase('http://localhost:11434')).toBe('http://localhost:11434/v1')
    expect(ollamaOpenAIBase('http://host.docker.internal:11434')).toBe('http://host.docker.internal:11434/v1')
  })

  test('leaves an already-correct URL alone', () => {
    expect(ollamaOpenAIBase('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
  })

  test('tolerates trailing slashes', () => {
    expect(ollamaOpenAIBase('http://localhost:11434/')).toBe('http://localhost:11434/v1')
    expect(ollamaOpenAIBase('http://localhost:11434/api/')).toBe('http://localhost:11434/v1')
    expect(ollamaOpenAIBase('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1')
  })

  test('does not mangle a path-prefixed host (reverse proxy)', () => {
    // A proxy mounting ollama under a subpath must keep the prefix.
    expect(ollamaOpenAIBase('https://gw.example.com/ollama')).toBe('https://gw.example.com/ollama/v1')
    expect(ollamaOpenAIBase('https://gw.example.com/ollama/api')).toBe('https://gw.example.com/ollama/v1')
  })
})
