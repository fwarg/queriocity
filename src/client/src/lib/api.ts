const BASE = '/api'

export interface AuthUser {
  id: string
  email: string
  name: string | null
  role: 'user' | 'admin'
  settings: { customPrompt?: string; showThinking?: { balanced: boolean; thorough: boolean }; useThinking?: boolean; useSpaceRag?: boolean; useChatRag?: boolean; querySuggestions?: boolean; followUpSuggestions?: boolean; userMemory?: boolean; imageWatermark?: boolean; fontSize?: number; timezone?: string }
  memoryTokenBudget: number
  /** True after an admin issued a temporary password — the user must set their own. */
  mustChangePassword?: boolean
}

export interface Space {
  id: string
  name: string
  /** Locked: no web search, URL fetching or image generation for any chat in this space.
   *  Effectively one-way once the space holds anything — see the server's canUnlock. */
  offline: boolean
  chatCount: number
  memoryCount: number
  createdAt: number
}

export interface SpaceMemory {
  id: string; content: string; source: 'tool' | 'extraction' | 'manual' | 'compact'
  sessionId: string | null; createdAt: number; alwaysKeep: boolean
}

/** `content` is a short snippet, shown as a preview when hovering the [N] citation. */
export interface Source { title: string; url: string; content?: string }

export interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  fileSources?: Array<{ title: string; url: string }>
  thinking?: string
  images?: Array<{ url: string; alt: string }>
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

export async function fetchSuggestions(text: string): Promise<string[]> {
  try {
    const res = await fetch(`${BASE}/chat/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) return []
    return res.json()
  } catch { return [] }
}

export async function updateSettings(settings: AuthUser["settings"]): Promise<void> {
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

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${BASE}/users/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e.error ?? 'Could not change password')
  }
}

export async function resetUserPassword(id: string): Promise<{ tempPassword: string }> {
  const res = await fetch(`${BASE}/admin/users/${id}/reset-password`, { method: 'POST' })
  if (!res.ok) throw new Error('Could not reset password')
  return res.json()
}

export interface Invite {
  token: string
  email: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
}

export async function listInvites(): Promise<Invite[]> {
  const res = await fetch(`${BASE}/admin/invites`)
  return res.json()
}

export async function revokeInvite(token: string): Promise<void> {
  await fetch(`${BASE}/admin/invites/${token}`, { method: 'DELETE' })
}

export type ModelTestResult = { role: string; model: string; ok: boolean; ms: number; info: string }

export async function testModels(): Promise<ModelTestResult[]> {
  const res = await fetch(`${BASE}/admin/models-test`)
  return res.json()
}

// Chat
export async function* streamChat(
  messages: Message[],
  focusMode: 'flash' | 'balanced' | 'thorough' | 'image',
  sessionId?: string,
  signal?: AbortSignal,
  spaceId?: string,
  ephemeral?: boolean,
  searchCategories?: Array<'news' | 'science' | 'discussions' | 'tech'>,
  includeFileIds?: string[],
  includeMemoryIds?: string[],
  regenerate?: boolean,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: messages.map(m => ({
        role: m.role,
        content: m.images?.length
          ? m.content + m.images.map(img => `\n\n![${img.alt}](${img.url})`).join('')
          : m.content,
      })),
      focusMode,
      sessionId,
      spaceId,
      ...(ephemeral ? { ephemeral: true } : {}),
      ...(searchCategories?.length ? { searchCategories } : {}),
      ...(includeFileIds?.length ? { includeFileIds } : {}),
      ...(includeMemoryIds?.length ? { includeMemoryIds } : {}),
      ...(regenerate ? { regenerate: true } : {}),
    }),
    signal,
  })

  if (!res.ok || !res.body) {
    let detail = ''
    try { detail = (await res.json()).error ?? '' } catch {}
    throw new Error(detail || `Chat error: ${res.status}`)
  }

  // The server keeps generating for a grace period after a dropped connection and buffers
  // every event, so a network blip mid-answer is recovered by asking for what we missed
  // rather than losing minutes of work. `seen` is the resume cursor.
  let seen = 0
  let sid = sessionId
  let finished = false

  async function* readEvents(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader()
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
          if (!line.startsWith('data: ')) continue
          let payload: { type: string; [k: string]: unknown }
          try { payload = JSON.parse(line.slice(6)) } catch { continue }
          // Before the cursor bump: pings are keepalives, never recorded in the resume buffer
          // on either the live or the resumed connection, so counting them would make `seen`
          // overshoot and the next resume would skip that many real events.
          if (payload.type === 'ping') continue
          seen++
          if (payload.type === 'session') { sid = payload.sessionId as string; continue }
          if (payload.type === 'done') finished = true
          yield payload
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  yield* readEvents(res.body)

  for (let attempt = 1; !finished && sid && !signal?.aborted && attempt <= RESUME_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, RESUME_BACKOFF_MS * attempt))
    if (signal?.aborted) break
    let resumed: Response
    try {
      resumed = await fetch(`${BASE}/chat/resume/${sid}?from=${seen}`, { signal })
    } catch {
      continue                      // still offline — try again until attempts run out
    }
    // 404 means the run is gone (finished long ago, or abandoned); nothing left to wait for.
    if (resumed.status === 404) break
    if (!resumed.ok || !resumed.body) continue
    yield* readEvents(resumed.body)
  }
}

const RESUME_ATTEMPTS = 4
const RESUME_BACKOFF_MS = 800

/** Asks the server to abandon a run. Best-effort — the run also self-abandons after its
 *  grace period, so a failure here only means the model keeps working a little longer. */
export async function stopChat(sessionId: string): Promise<void> {
  try {
    await fetch(`${BASE}/chat/${sessionId}/stop`, { method: 'POST' })
  } catch { /* nothing useful to do */ }
}

/** Answers an egress approval prompt. Returns false when the server had nothing parked under that
 *  id — it already timed out, or the run ended — so the caller can drop a prompt gone stale. */
export async function decideEgress(sessionId: string, id: string, allow: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/chat/${sessionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, allow }),
    })
    if (!res.ok) return false
    return (await res.json() as { settled: boolean }).settled
  } catch {
    return false
  }
}

/** The endpoint caps `question` at 2000 chars, and a message carrying an inlined attachment blows
 *  straight past that — the request came back 400 and the chips silently never appeared. Truncated
 *  here rather than raising the cap: only the question itself is useful for suggesting follow-ups,
 *  and the attachment body would just cost the small model context it does not have. */
const RELATED_QUESTION_MAX = 2000

export async function fetchRelatedQuestions(question: string, answer: string): Promise<string[]> {
  try {
    const res = await fetch(`${BASE}/chat/related`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question.slice(0, RELATED_QUESTION_MAX), answer }),
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export async function fetchSession(id: string): Promise<Message[]> {
  const res = await fetch(`${BASE}/history/${id}`)
  const { messages } = await res.json()
  const FIRST_PNG_RE = /!\[([^\]]*)\]\(([^)]+\.png)\)/
  return (messages as Array<{ role: 'user' | 'assistant'; content: string; sources?: string }>).map(m => {
    const sources = m.sources ? JSON.parse(m.sources) : undefined
    if (m.role === 'assistant') {
      const match = FIRST_PNG_RE.exec(m.content)
      return { role: m.role, content: m.content, sources, images: match ? [{ alt: match[1], url: match[2] }] : undefined }
    }
    return { role: m.role, content: m.content, sources }
  })
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

export async function fetchHistory(
  sort?: 'updated' | 'created',
  offset = 0,
  spaceId?: string,
): Promise<{ items: Array<{ id: string; title: string; spaceId: string | null }>; total: number }> {
  const params = new URLSearchParams()
  if (sort) params.set('sort', sort)
  if (offset) params.set('offset', String(offset))
  // Filtering server-side rather than in the caller: the response is one page, so a client-side
  // filter can only ever see the chats that page happens to contain.
  if (spaceId) params.set('spaceId', spaceId)
  const res = await fetch(`${BASE}/history?${params}`)
  return res.json()
}

export async function searchHistory(q: string): Promise<Array<{ id: string; title: string; spaceId: string | null }>> {
  const res = await fetch(`${BASE}/history/search?q=${encodeURIComponent(q)}`)
  return res.json()
}

export async function fetchSpaces(): Promise<Space[]> {
  const res = await fetch(`${BASE}/spaces`)
  return res.json()
}

export async function createSpace(name: string, offline = false): Promise<Space> {
  const res = await fetch(`${BASE}/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, offline }),
  })
  return res.json()
}

/** Rename and/or change the lock. Returns the server's refusal message when unlocking is not
 *  allowed, so the caller can show why rather than a generic failure. */
export async function updateSpace(
  id: string,
  patch: { name?: string; offline?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/spaces/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (res.ok) return { ok: true }
  const body = await res.json().catch(() => ({})) as { error?: string }
  return { ok: false, error: body.error ?? 'Could not update the space.' }
}

/** Deleting a locked space deletes its chats too — the server does this so they are not orphaned
 *  into unlocked ones. `deletedChats` is what actually went, for the confirmation message. */
export async function deleteSpace(id: string): Promise<{ deletedChats: number }> {
  const res = await fetch(`${BASE}/spaces/${id}`, { method: 'DELETE' })
  const body = await res.json().catch(() => ({})) as { deletedChats?: number }
  return { deletedChats: body.deletedChats ?? 0 }
}

export async function assignChatToSpace(chatId: string, spaceId: string | null): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/history/${chatId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceId }),
  })
  if (res.ok) return { ok: true }
  const body = await res.json().catch(() => ({})) as { error?: string }
  return { ok: false, error: body.error ?? 'Could not move the chat.' }
}

export async function recreateChatMemories(chatId: string): Promise<void> {
  await fetch(`${BASE}/history/${chatId}/recreate-memories`, { method: 'POST' })
}

export interface SpaceFile { id: string; filename: string; size: number; createdAt: number }

export async function fetchSpaceFiles(spaceId: string): Promise<SpaceFile[]> {
  return fetch(`${BASE}/spaces/${spaceId}/files`).then(r => r.json())
}

export async function tagFileToSpace(spaceId: string, fileId: string): Promise<void> {
  await fetch(`${BASE}/spaces/${spaceId}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
}

export async function untagFileFromSpace(spaceId: string, fileId: string): Promise<void> {
  await fetch(`${BASE}/spaces/${spaceId}/files/${fileId}`, { method: 'DELETE' })
}

export async function transformSpace(spaceId: string, operation: 'summarize', fileIds?: string[]): Promise<{ memoryId: string; content: string }> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, ...(fileIds?.length ? { fileIds } : {}) }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(e.error ?? 'Transform failed')
  }
  return res.json()
}

export async function ingestUrl(url: string): Promise<{ fileId: string; filename: string }> {
  const res = await fetch(`${BASE}/files/ingest-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(e.error ?? 'Failed to ingest URL')
  }
  return res.json()
}

export async function fetchAdminSettings(): Promise<{ memoryTokenBudget: number; userMemoryTokenBudget: number; dreamHour: number; dreamThreshold: number; dreamTarget: number; dreamDeep: boolean; memoryExtractChars: number; rerankTopN: number; attachmentChars: number; spaceRagBudget: number; queryReformulation: boolean; rssFeedCharsBudget: number; fetchMaxPages: number; fetchSummarizeOverflow: boolean; compressHistoryOverflow: boolean }> {
  return fetch(`${BASE}/admin/settings`).then(r => r.json())
}

export async function updateAdminSettings(s: { memoryTokenBudget?: number; userMemoryTokenBudget?: number; dreamHour?: number; dreamThreshold?: number; dreamTarget?: number; dreamDeep?: boolean; memoryExtractChars?: number; rerankTopN?: number; attachmentChars?: number; spaceRagBudget?: number; queryReformulation?: boolean; rssFeedCharsBudget?: number; fetchMaxPages?: number; fetchSummarizeOverflow?: boolean; compressHistoryOverflow?: boolean }): Promise<void> {
  await fetch(`${BASE}/admin/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
}

export async function triggerDream(): Promise<void> {
  await fetch(`${BASE}/admin/dream/run`, { method: 'POST' })
}

export async function reindexChats(): Promise<{ sessions: number }> {
  const res = await fetch(`${BASE}/admin/reindex-chats`, { method: 'POST' })
  return res.json()
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

export async function fetchChatIndexStatus(spaceId: string): Promise<{ indexed: number; total: number }> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/chat-index-status`)
  return res.json()
}

export async function* rebuildChatIndex(
  spaceId: string,
  signal?: AbortSignal,
): AsyncGenerator<{ processing?: number; total?: number; done?: boolean; errors?: number }> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/rebuild-chat-index`, { method: 'POST', signal })
  if (!res.ok || !res.body) throw new Error('Rebuild failed')
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
        if (line.startsWith('data: ')) { try { yield JSON.parse(line.slice(6)) } catch {} }
      }
    }
  } finally { reader.releaseLock() }
}

export async function fetchSpaceMemories(spaceId: string): Promise<{ memories: SpaceMemory[] }> {
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

export async function updateSpaceMemory(
  spaceId: string,
  memoryId: string,
  updates: { content?: string; alwaysKeep?: boolean },
): Promise<void> {
  await fetch(`${BASE}/spaces/${spaceId}/memories/${memoryId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
}

export async function deleteSpaceMemory(spaceId: string, memoryId: string): Promise<void> {
  await fetch(`${BASE}/spaces/${spaceId}/memories/${memoryId}`, { method: 'DELETE' })
}

/** Account-wide facts, injected into every chat when the userMemory setting is on. */
export interface UserMemory {
  id: string; content: string; source: 'tool' | 'manual'
  alwaysKeep: boolean; createdAt: number
}

export async function fetchUserMemories(): Promise<{ memories: UserMemory[] }> {
  const res = await fetch(`${BASE}/users/memories`)
  if (!res.ok) throw new Error('Failed to load user memories')
  return res.json()
}

export async function createUserMemory(content: string): Promise<UserMemory> {
  const res = await fetch(`${BASE}/users/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error('Failed to create user memory')
  return res.json()
}

export async function updateUserMemory(
  memoryId: string,
  updates: { content?: string; alwaysKeep?: boolean },
): Promise<void> {
  await fetch(`${BASE}/users/memories/${memoryId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
}

export async function deleteUserMemory(memoryId: string): Promise<void> {
  await fetch(`${BASE}/users/memories/${memoryId}`, { method: 'DELETE' })
}

/** Streams scan progress, then the proposed facts. Nothing is stored until the user accepts one. */
export async function* suggestUserMemories(
  sessionLimit?: number,
  signal?: AbortSignal,
): AsyncGenerator<{ processing?: number; total?: number; done?: boolean; suggestions?: string[]; error?: string }> {
  const qs = sessionLimit ? `?limit=${sessionLimit}` : ''
  const res = await fetch(`${BASE}/users/memories/suggest${qs}`, { method: 'POST', signal })
  if (!res.ok || !res.body) throw new Error('Suggestion scan failed')
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
    reader.cancel().catch(() => {})
  }
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

export interface CustomTemplate {
  id: string
  name: string
  description?: string
  promptText: string
  suggestedMode: 'flash' | 'balanced' | 'thorough' | 'image'
  createdAt: number
}

export async function fetchCustomTemplates(): Promise<CustomTemplate[]> {
  const res = await fetch(`${BASE}/templates`)
  return res.json()
}

export async function createCustomTemplate(t: Omit<CustomTemplate, 'id' | 'createdAt'>): Promise<CustomTemplate> {
  const res = await fetch(`${BASE}/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'Create failed' }))
    throw new Error(error ?? 'Create failed')
  }
  return res.json()
}

export async function updateCustomTemplate(id: string, t: Partial<Omit<CustomTemplate, 'id' | 'createdAt'>>): Promise<void> {
  await fetch(`${BASE}/templates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  })
}

export async function deleteCustomTemplate(id: string): Promise<void> {
  await fetch(`${BASE}/templates/${id}`, { method: 'DELETE' })
}

export interface Monitor {
  id: string
  name: string
  promptText: string
  focusMode: 'flash' | 'balanced' | 'thorough'
  intervalMinutes: number
  keepCount: number
  preferredHour?: number | null
  timezone?: string | null
  feedSources?: string[] | null
  isGlobal: boolean
  spaceId?: string | null
  enabled: boolean
  nextRunAt?: number
  lastRunAt?: number
  createdAt: number
  subscribed?: boolean
}

export interface MonitorRun {
  id: string
  monitorId: string
  sessionId: string
  runAt: number
}

export async function fetchMonitors(): Promise<Monitor[]> {
  const res = await fetch(`${BASE}/monitors`)
  return res.json()
}

export async function createMonitor(m: Omit<Monitor, 'id' | 'createdAt' | 'isGlobal'>): Promise<Monitor> {
  const res = await fetch(`${BASE}/monitors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(m),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'Create failed' }))
    throw new Error(error ?? 'Create failed')
  }
  return res.json()
}

export async function updateMonitor(id: string, m: Partial<Omit<Monitor, 'id' | 'createdAt' | 'isGlobal'>>): Promise<void> {
  await fetch(`${BASE}/monitors/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(m),
  })
}

export async function deleteMonitor(id: string): Promise<void> {
  await fetch(`${BASE}/monitors/${id}`, { method: 'DELETE' })
}

export async function triggerMonitorRun(id: string): Promise<void> {
  const res = await fetch(`${BASE}/monitors/${id}/run`, { method: 'POST' })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'Run failed' }))
    throw new Error(error ?? 'Run failed')
  }
}

export async function fetchMonitorRuns(id: string): Promise<MonitorRun[]> {
  const res = await fetch(`${BASE}/monitors/${id}/runs`)
  return res.json()
}

export async function subscribeMonitor(id: string): Promise<void> {
  await fetch(`${BASE}/monitors/${id}/subscribe`, { method: 'POST' })
}

export async function unsubscribeMonitor(id: string): Promise<void> {
  await fetch(`${BASE}/monitors/${id}/subscribe`, { method: 'DELETE' })
}

export async function fetchGlobalMonitors(): Promise<Monitor[]> {
  const res = await fetch(`${BASE}/monitors/global`)
  return res.json()
}

export async function createGlobalMonitor(m: Omit<Monitor, 'id' | 'createdAt' | 'isGlobal' | 'subscribed'>): Promise<Monitor> {
  const res = await fetch(`${BASE}/monitors/global`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(m),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'Create failed' }))
    throw new Error(error ?? 'Create failed')
  }
  return res.json()
}

export async function updateGlobalMonitor(id: string, m: Partial<Omit<Monitor, 'id' | 'createdAt' | 'isGlobal'>>): Promise<void> {
  await fetch(`${BASE}/monitors/global/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(m),
  })
}

export async function deleteGlobalMonitor(id: string): Promise<void> {
  await fetch(`${BASE}/monitors/global/${id}`, { method: 'DELETE' })
}

export interface FeedSource {
  name: string
  country: string
  topic: string
  type: string
  language: string
  ownership: string
  rss_status: string
  rss: string
}

export interface FeedRegion {
  region: string
  sources: FeedSource[]
}

export async function fetchFeeds(): Promise<FeedRegion[]> {
  const res = await fetch(`${BASE}/feeds`)
  return res.json()
}
