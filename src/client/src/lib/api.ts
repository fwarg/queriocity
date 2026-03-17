const BASE = '/api'

export interface AuthUser {
  id: string
  email: string
  name: string | null
  role: 'user' | 'admin'
  settings: { customPrompt?: string }
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Array<{ title: string; url: string }>
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

export async function updateSettings(settings: { customPrompt?: string }): Promise<void> {
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

// Chat
export async function* streamChat(
  messages: Message[],
  focusMode: 'flash' | 'fast' | 'balanced' | 'thorough',
  sessionId?: string,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, focusMode, sessionId }),
  })

  if (!res.ok || !res.body) throw new Error(`Chat error: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

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

export async function deleteSession(id: string): Promise<void> {
  await fetch(`${BASE}/history/${id}`, { method: 'DELETE' })
}

export async function fetchHistory() {
  const res = await fetch(`${BASE}/history`)
  return res.json()
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
