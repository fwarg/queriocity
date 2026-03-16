const BASE = '/api'

function getToken(): string {
  return localStorage.getItem('token') ?? ''
}

export async function ensureSession(): Promise<string> {
  const existing = localStorage.getItem('token')
  if (existing) return existing

  const userId = localStorage.getItem('userId') ?? undefined
  const res = await fetch(`${BASE}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  })
  const { token, userId: uid } = await res.json()
  localStorage.setItem('token', token)
  localStorage.setItem('userId', uid)
  return token
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Array<{ title: string; url: string }>
}

export async function* streamChat(
  messages: Message[],
  focusMode: 'speed' | 'balanced' | 'thorough',
  sessionId?: string,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
  const token = await ensureSession()
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
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
        try {
          yield JSON.parse(line.slice(6))
        } catch {}
      }
    }
  }
}

export async function fetchSession(id: string): Promise<Message[]> {
  const token = await ensureSession()
  const res = await fetch(`${BASE}/history/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const { messages } = await res.json()
  return (messages as Array<{ role: 'user' | 'assistant'; content: string; sources?: string }>).map(m => ({
    role: m.role,
    content: m.content,
    sources: m.sources ? JSON.parse(m.sources) : undefined,
  }))
}

export async function deleteSession(id: string): Promise<void> {
  const token = await ensureSession()
  await fetch(`${BASE}/history/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}

export async function fetchHistory() {
  const token = await ensureSession()
  const res = await fetch(`${BASE}/history`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.json()
}

export async function uploadFile(file: File) {
  const token = await ensureSession()
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  return res.json()
}
