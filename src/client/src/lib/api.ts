const BASE = '/api'

export interface AuthUser {
  id: string
  email: string
  name: string | null
  role: 'user' | 'admin'
  settings: { customPrompt?: string; showThinking?: { balanced: boolean; thorough: boolean }; useThinking?: boolean; fontSize?: number }
  memoryTokenBudget: number
}

export interface Space { id: string; name: string; chatCount: number; memoryCount: number; createdAt: number }

export interface SpaceMemory {
  id: string; content: string; source: 'tool' | 'extraction' | 'manual' | 'compact'
  sessionId: string | null; createdAt: number
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Array<{ title: string; url: string }>
  thinking?: string
}

// Auth — cookies are sent automatically by the browser
export async function getMe(): Promise<AuthUser | null> {
  const res = await fetch(`${BASE}/auth/me`)
  if (!res.ok) return null
  return res.json()
}

export async function hasUsers(): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/has-users`)
  const data = await res.json()
  return data.hasUsers
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const { error } = await res.json()
    throw new Error(error ?? 'Login failed')
  }
  return res.json()
}

export async function register(email: string, password: string, name?: string, inviteToken?: string): Promise<AuthUser> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, inviteToken }),
  })
  if (!res.ok) {
    const { error } = await res.json()
    throw new Error(error ?? 'Registration failed')
  }
  return res.json()
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: 'POST' })
}

export async function updateSettings(settings: { customPrompt?: string; showThinking?: { balanced: boolean; thorough: boolean }; useThinking?: boolean; fontSize?: number }): Promise<void> {
  await fetch(`${BASE}/users/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

// Admin
export async function listUsers(): Promise<Array<{ id: string; email: string; name: string | null; role: string; createdAt: number }>> {
  const res = await fetch(`${BASE}/admin/users`)
  return res.json()
}

export async function setUserRole(id: string, role: 'user' | 'admin'): Promise<void> {
  await fetch(`${BASE}/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
}

export async function deleteUser(id: string): Promise<void> {
  await fetch(`${BASE}/admin/users/${id}`, { method: 'DELETE' })
}

export async function createInvite(email?: string): Promise<{ token: string; expiresAt: string }> {
  const res = await fetch(`${BASE}/admin/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  return res.json()
}

export type ModelTestResult = { role: string; model: string; ok: boolean; ms: number; info: string }

export async function testModels(): Promise<ModelTestResult[]> {
  const res = await fetch(`${BASE}/admin/models-test`)
  return res.json()
}

// Chat
export async function* streamChat(
  messages: Message[],
  focusMode: 'flash' | 'fast' | 'balanced' | 'thorough',
  sessionId?: string,
  signal?: AbortSignal,
  spaceId?: string,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, focusMode, sessionId, spaceId }),
    signal,
  })

  if (!res.ok || !res.body) {
    let detail = ''
    try { detail = (await res.json()).error ?? '' } catch {}
    throw new Error(detail || `Chat error: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)) } catch {}
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function fetchSession(id: string): Promise<Message[]> {
  const res = await fetch(`${BASE}/history/${id}`)
  const { messages } = await res.json()
  return (messages as Array<{ role: 'user' | 'assistant'; content: string; sources?: string }>).map(m => ({
    role: m.role,
    content: m.content,
    sources: m.sources ? JSON.parse(m.sources) : undefined,
  }))
}

export async function updateSessionTitle(id: string, title: string): Promise<void> {
  await fetch(`${BASE}/history/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`${BASE}/history/${id}`, { method: 'DELETE' })
}

export async function fetchHistory(): Promise<Array<{ id: string; title: string; spaceId: string | null }>> {
  const res = await fetch(`${BASE}/history`)
  return res.json()
}

export async function fetchSpaces(): Promise<Space[]> {
  const res = await fetch(`${BASE}/spaces`)
  return res.json()
}

export async function createSpace(name: string): Promise<Space> {
  const res = await fetch(`${BASE}/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return res.json()
}

export async function updateSpace(id: string, name: string): Promise<void> {
  await fetch(`${BASE}/spaces/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export async function deleteSpace(id: string): Promise<void> {
  await fetch(`${BASE}/spaces/${id}`, { method: 'DELETE' })
}

export async function assignChatToSpace(chatId: string, spaceId: string | null): Promise<void> {
  await fetch(`${BASE}/history/${chatId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceId }),
  })
}

export async function recreateChatMemories(chatId: string): Promise<void> {
  await fetch(`${BASE}/history/${chatId}/recreate-memories`, { method: 'POST' })
}

export async function fetchAdminSettings(): Promise<{ memoryTokenBudget: number; dreamHour: number; dreamThreshold: number; dreamTarget: number; memoryExtractChars: number; rerankTopN: number; attachmentChars: number }> {
  return fetch(`${BASE}/admin/settings`).then(r => r.json())
}

export async function updateAdminSettings(s: { memoryTokenBudget?: number; dreamHour?: number; dreamThreshold?: number; dreamTarget?: number; memoryExtractChars?: number; rerankTopN?: number; attachmentChars?: number }): Promise<void> {
  await fetch(`${BASE}/admin/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
}

export async function clearSpaceMemories(spaceId: string): Promise<void> {
  await fetch(`${BASE}/spaces/${spaceId}/memories`, { method: 'DELETE' })
}

export async function compactSpaceMemories(spaceId: string): Promise<{ before: number; after: number; compacted: boolean }> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/compact`, { method: 'POST' })
  return res.json()
}

export async function* recreateAllSpaceMemories(
  spaceId: string,
  signal?: AbortSignal,
): AsyncGenerator<{ processing?: number; total?: number; done?: boolean; errors?: number }> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/recreate-memories`, { method: 'POST', signal })
  if (!res.ok || !res.body) throw new Error('Recreate failed')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)) } catch {}
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function fetchSpaceMemories(spaceId: string): Promise<SpaceMemory[]> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/memories`)
  return res.json()
}

export async function createSpaceMemory(spaceId: string, content: string): Promise<SpaceMemory> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  return res.json()
}

export async function updateSpaceMemory(spaceId: string, memoryId: string, content: string): Promise<void> {
  await fetch(`${BASE}/spaces/${spaceId}/memories/${memoryId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

export async function deleteSpaceMemory(spaceId: string, memoryId: string): Promise<void> {
  await fetch(`${BASE}/spaces/${spaceId}/memories/${memoryId}`, { method: 'DELETE' })
}

export async function extractFileForContext(file: File): Promise<{ filename: string; content: string }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/files/extract`, { method: 'POST', body: form })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'Extraction failed' }))
    throw new Error(error ?? 'Extraction failed')
  }
  return res.json()
}

export async function uploadFile(file: File): Promise<{ fileId: string; filename: string }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/files/upload`, { method: 'POST', body: form })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(error ?? 'Upload failed')
  }
  return res.json()
}

export async function fetchFiles(): Promise<Array<{ id: string; filename: string; mimeType: string; size: number; createdAt: number }>> {
  const res = await fetch(`${BASE}/files`)
  return res.json()
}

export async function deleteFile(id: string): Promise<void> {
  await fetch(`${BASE}/files/${id}`, { method: 'DELETE' })
}
