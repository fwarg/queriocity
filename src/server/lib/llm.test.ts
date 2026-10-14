import { describe, test, expect } from 'bun:test'
import { ollamaOpenAIBase, modelTarget, flashTarget, displayName, DEFAULT_BASE_URL, DEFAULT_CHAT_MODEL, DEFAULT_EMBED_MODEL } from './llm.ts'

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

const MODEL_ENV = [
  'BASE_URL', 'BASE_PROVIDER', 'CONTEXT_TOKEN_LIMIT', 'SMALL_MODEL_CONTEXT_TOKENS', 'EMBED_CONTEXT_TOKENS', 'FLASH_MODEL',
  ...['CHAT', 'SMALL', 'THINKING', 'EMBED'].flatMap(p => [`${p}_MODEL`, `${p}_MODEL_LABEL`, `${p}_BASE_URL`, `${p}_PROVIDER`, `${p}_API_KEY`]),
]

/** Runs `fn` with only `vars` set among the model env vars, restoring the previous env after. */
function withEnv(vars: Record<string, string>, fn: () => void) {
  const saved = Object.fromEntries(MODEL_ENV.map(k => [k, process.env[k]]))
  for (const k of MODEL_ENV) delete process.env[k]
  Object.assign(process.env, vars)
  try { fn() } finally {
    for (const k of MODEL_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

describe('modelTarget', () => {
  test('defaults when nothing is set', () => withEnv({}, () => {
    const chat = modelTarget('chat')
    expect(chat).toMatchObject({ provider: 'openai', baseURL: DEFAULT_BASE_URL, model: DEFAULT_CHAT_MODEL, contextTokens: 8192 })
    expect(modelTarget('small')).toMatchObject({ model: DEFAULT_CHAT_MODEL, contextTokens: 4096, configured: false })
    expect(modelTarget('embed')).toMatchObject({ model: DEFAULT_EMBED_MODEL, contextTokens: 1024, configured: false })
  }))

  test('roles inherit the chat endpoint, which inherits BASE_*', () => withEnv({
    BASE_URL: 'http://base:1/v1', BASE_PROVIDER: 'ollama', CHAT_API_KEY: 'k', CHAT_MODEL: 'big',
  }, () => {
    expect(modelTarget('thinking')).toMatchObject({ provider: 'ollama', baseURL: 'http://base:1/v1', apiKey: 'k', model: 'big' })
  }))

  test('a role\'s own settings win over the chat model\'s', () => withEnv({
    CHAT_BASE_URL: 'http://chat/v1', SMALL_BASE_URL: 'http://small/v1', SMALL_MODEL: 'tiny', SMALL_API_KEY: 's',
  }, () => {
    expect(modelTarget('small')).toMatchObject({ baseURL: 'http://small/v1', model: 'tiny', apiKey: 's', configured: true })
  }))

  test('context tokens per role; thinking shares the chat limit', () => withEnv({
    CONTEXT_TOKEN_LIMIT: '32768', SMALL_MODEL_CONTEXT_TOKENS: '2048', EMBED_CONTEXT_TOKENS: 'junk',
  }, () => {
    expect(modelTarget('chat').contextTokens).toBe(32768)
    expect(modelTarget('thinking').contextTokens).toBe(32768)
    expect(modelTarget('small').contextTokens).toBe(2048)
    expect(modelTarget('embed').contextTokens).toBe(1024)
  }))

  test('flash runs on the small model only when FLASH_MODEL=small', () => {
    withEnv({ CONTEXT_TOKEN_LIMIT: '32768', SMALL_MODEL_CONTEXT_TOKENS: '2048' }, () => {
      expect(flashTarget().contextTokens).toBe(32768)
    })
    withEnv({ CONTEXT_TOKEN_LIMIT: '32768', SMALL_MODEL_CONTEXT_TOKENS: '2048', FLASH_MODEL: 'small' }, () => {
      expect(flashTarget()).toMatchObject({ role: 'small', contextTokens: 2048 })
    })
  })
})

describe('model labels', () => {
  test('use *_MODEL_LABEL, fall back to the model name, and follow the chat model when borrowed', () => {
    withEnv({ CHAT_MODEL: 'gemma4-large', CHAT_MODEL_LABEL: 'Gemma 4', THINKING_MODEL: 'gemma4-think' }, () => {
      expect(displayName(modelTarget('chat'))).toBe('Gemma 4')
      // Its own model and no label of its own: the model name, not the chat model's label.
      expect(displayName(modelTarget('thinking'))).toBe('gemma4-think')
      // Borrowing the chat model: the chat model's label too.
      expect(displayName(modelTarget('small'))).toBe('Gemma 4')
    })
  })
})
