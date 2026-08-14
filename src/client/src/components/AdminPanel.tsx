import { useState, useEffect } from 'react'
import { listUsers, setUserRole, deleteUser, createInvite, listInvites, revokeInvite, resetUserPassword, testModels, fetchAdminSettings, updateAdminSettings, triggerDream, reindexChats, type ModelTestResult, type Invite } from '../lib/api.ts'
import { Modal } from './Modal.tsx'

interface Props {
  currentUserId: string
  onClose: () => void
  onBudgetChange?: (budget: number) => void
}

type UserRow = { id: string; email: string; name: string | null; role: string; createdAt: number }
type Tab = 'settings' | 'users'

export function AdminPanel({ currentUserId, onClose, onBudgetChange }: Props) {
  const [tab, setTab] = useState<Tab>('settings')

  // Settings tab state
  const [budgetDraft, setBudgetDraft] = useState('1000')
  const [dreamHourDraft, setDreamHourDraft] = useState('-1')
  const [dreamThresholdDraft, setDreamThresholdDraft] = useState('1500')
  const [dreamTargetDraft, setDreamTargetDraft] = useState('700')
  const [dreamDeepDraft, setDreamDeepDraft] = useState(false)
  const [extractCharsDraft, setExtractCharsDraft] = useState('6000')
  const [rerankTopNDraft, setRerankTopNDraft] = useState('15')
  const [ragTopKDraft, setRagTopKDraft] = useState('15')
  // Derived server-side from the model context env vars; two settings below are clamped by them.
  const [limits, setLimits] = useState<{ smallModelInputChars: number; embedInputChars: number; scrapeMaxChars: number; minUrlContextChars: number } | null>(null)
  const [attachmentCharsDraft, setAttachmentCharsDraft] = useState('20000')
  const [spaceRagBudgetDraft, setSpaceRagBudgetDraft] = useState('500')
  const [userMemoryBudgetDraft, setUserMemoryBudgetDraft] = useState('300')
  const [queryReformulationDraft, setQueryReformulationDraft] = useState(true)
  const [rssFeedCharsBudgetDraft, setRssFeedCharsBudgetDraft] = useState('50000')
  const [fetchMaxPagesDraft, setFetchMaxPagesDraft] = useState('8')
  const [fetchMaxUrlContextCharsDraft, setFetchMaxUrlContextCharsDraft] = useState('40000')
  const [fetchSummarizeOverflowDraft, setFetchSummarizeOverflowDraft] = useState(false)
  const [compressHistoryOverflowDraft, setCompressHistoryOverflowDraft] = useState(false)
  const [savingBudget, setSavingBudget] = useState(false)
  const [budgetSaved, setBudgetSaved] = useState(false)
  const [dreamRunning, setDreamRunning] = useState(false)
  const [dreamTriggered, setDreamTriggered] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [reindexResult, setReindexResult] = useState<number | null>(null)
  const [modelResults, setModelResults] = useState<ModelTestResult[] | null>(null)
  const [testingModels, setTestingModels] = useState(false)

  // Users tab state
  const [userList, setUserList] = useState<UserRow[]>([])
  const [inviteUrl, setInviteUrl] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [invites, setInvites] = useState<Invite[]>([])
  // Shown once after a reset — the password is not recoverable afterwards.
  const [tempPassword, setTempPassword] = useState<{ id: string; password: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchAdminSettings().then(s => {
      setBudgetDraft(String(s.memoryTokenBudget))
      setDreamHourDraft(String(s.dreamHour))
      setDreamThresholdDraft(String(s.dreamThreshold))
      setDreamTargetDraft(String(s.dreamTarget))
      setDreamDeepDraft(s.dreamDeep)
      setExtractCharsDraft(String(s.memoryExtractChars))
      setRerankTopNDraft(String(s.rerankTopN))
      setRagTopKDraft(String(s.ragTopK))
      setLimits(s.limits)
      setAttachmentCharsDraft(String(s.attachmentChars))
      setSpaceRagBudgetDraft(String(s.spaceRagBudget))
      setUserMemoryBudgetDraft(String(s.userMemoryTokenBudget))
      setQueryReformulationDraft(s.queryReformulation)
      setRssFeedCharsBudgetDraft(String(s.rssFeedCharsBudget))
      setFetchMaxPagesDraft(String(s.fetchMaxPages))
      setFetchMaxUrlContextCharsDraft(String(s.fetchMaxUrlContextChars))
      setFetchSummarizeOverflowDraft(s.fetchSummarizeOverflow)
      setCompressHistoryOverflowDraft(s.compressHistoryOverflow)
    }).catch(() => setError('Failed to load settings.'))
  }, [])

  useEffect(() => {
    if (tab === 'users' && userList.length === 0) {
      listUsers().then(setUserList).catch(() => setError('Failed to load users.'))
      listInvites().then(setInvites).catch(() => setError('Failed to load invites.'))
    }
  }, [tab])

  async function handleSaveSettings() {
    const budget = parseInt(budgetDraft)
    const dreamHour = parseInt(dreamHourDraft)
    const dreamThreshold = parseInt(dreamThresholdDraft)
    const dreamTarget = parseInt(dreamTargetDraft)
    const extractChars = parseInt(extractCharsDraft)
    const rerankTopN = parseInt(rerankTopNDraft)
    const ragTopK = parseInt(ragTopKDraft)
    const attachmentChars = parseInt(attachmentCharsDraft)
    const spaceRagBudget = parseInt(spaceRagBudgetDraft)
    const userMemoryTokenBudget = parseInt(userMemoryBudgetDraft)
    const rssFeedCharsBudget = parseInt(rssFeedCharsBudgetDraft)
    const fetchMaxPages = parseInt(fetchMaxPagesDraft)
    const fetchMaxUrlContextChars = parseInt(fetchMaxUrlContextCharsDraft)
    const scrapeMax = limits?.scrapeMaxChars ?? Infinity
    const minUrlChars = limits?.minUrlContextChars ?? 8000
    if (isNaN(budget) || budget < 100 || budget > 10000) return
    if (isNaN(dreamHour) || dreamHour < -1 || dreamHour > 23) return
    if (isNaN(dreamThreshold) || dreamThreshold < 100) return
    if (isNaN(dreamTarget) || dreamTarget < 100) return
    if (isNaN(extractChars) || extractChars < 500) return
    if (isNaN(rerankTopN) || rerankTopN < 1) return
    if (isNaN(attachmentChars) || attachmentChars < 1000) return
    if (isNaN(spaceRagBudget) || spaceRagBudget < 0) return
    if (isNaN(userMemoryTokenBudget) || userMemoryTokenBudget < 0) return
    if (isNaN(rssFeedCharsBudget) || rssFeedCharsBudget < 5000) return
    if (isNaN(fetchMaxPages) || fetchMaxPages < 0) return
    if (isNaN(fetchMaxUrlContextChars) || fetchMaxUrlContextChars < minUrlChars) return
    if (fetchMaxUrlContextChars > scrapeMax) { setError(`Per-URL context cap must be \u2264 the scrape ceiling (${scrapeMax} chars, set by FETCH_MAX_CHARS).`); return }
    if (dreamTarget > dreamThreshold) { setError('Dream target must be ≤ dream threshold.'); return }
    if (dreamThreshold > budget) { setError('Dream threshold must be ≤ memory token budget.'); return }
    setError('')
    setSavingBudget(true)
    try {
      await updateAdminSettings({ memoryTokenBudget: budget, userMemoryTokenBudget, dreamHour, dreamThreshold, dreamTarget, dreamDeep: dreamDeepDraft, memoryExtractChars: extractChars, rerankTopN, ragTopK, attachmentChars, spaceRagBudget, queryReformulation: queryReformulationDraft, rssFeedCharsBudget, fetchMaxPages, fetchMaxUrlContextChars, fetchSummarizeOverflow: fetchSummarizeOverflowDraft, compressHistoryOverflow: compressHistoryOverflowDraft })

      onBudgetChange?.(budget)
      setBudgetSaved(true)
      setTimeout(() => setBudgetSaved(false), 2000)
    } catch {
      setError('Failed to save settings.')
    } finally {
      setSavingBudget(false)
    }
  }

  async function handleReindexChats() {
    setReindexing(true)
    setReindexResult(null)
    try {
      const { sessions } = await reindexChats()
      setReindexResult(sessions)
      setTimeout(() => setReindexResult(null), 5000)
    } finally {
      setReindexing(false)
    }
  }

  async function handleTestModels() {
    setTestingModels(true)
    setModelResults(null)
    try {
      setModelResults(await testModels())
    } finally {
      setTestingModels(false)
    }
  }

  async function handleRunDream() {
    setDreamRunning(true)
    try {
      await triggerDream()
      setDreamTriggered(true)
      setTimeout(() => setDreamTriggered(false), 3000)
    } finally {
      setDreamRunning(false)
    }
  }

  async function handleRoleToggle(u: UserRow) {
    const newRole = u.role === 'admin' ? 'user' : 'admin'
    try {
      await setUserRole(u.id, newRole)
      setUserList(prev => prev.map(x => x.id === u.id ? { ...x, role: newRole } : x))
    } catch {
      setError('Failed to update role.')
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this user and all their data?')) return
    try {
      await deleteUser(id)
      setUserList(prev => prev.filter(x => x.id !== id))
    } catch {
      setError('Failed to delete user.')
    }
  }

  async function handleCreateInvite() {
    setBusy(true)
    try {
      const { token } = await createInvite(inviteEmail || undefined)
      const url = `${window.location.origin}/register?token=${token}`
      setInviteUrl(url)
      setInvites(await listInvites())
    } finally {
      setBusy(false)
    }
  }

  async function handleResetPassword(id: string) {
    if (!confirm('Replace this user\'s password with a temporary one? Their current password stops working and any open session is signed out.')) return
    setBusy(true)
    setError('')
    try {
      const { tempPassword } = await resetUserPassword(id)
      setTempPassword({ id, password: tempPassword })
    } catch {
      setError('Failed to reset password.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRevokeInvite(token: string) {
    setBusy(true)
    try {
      await revokeInvite(token)
      setInvites(await listInvites())
    } catch {
      setError('Failed to revoke invite.')
    } finally {
      setBusy(false)
    }
  }

  /** 'used', 'expired', or the remaining lifetime — an invite is only usable while pending. */
  function inviteStatus(i: Invite): string {
    if (i.usedAt) return 'used'
    const msLeft = new Date(i.expiresAt).getTime() - Date.now()
    if (msLeft <= 0) return 'expired'
    const days = Math.ceil(msLeft / 86400_000)
    return days > 1 ? `${days} days left` : 'expires today'
  }

  const tabBtn = (t: Tab, _label: string) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-indigo-500 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300'}`

  return (
    <Modal title="Admin" onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex flex-col gap-0">
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        {/* Tabs */}
        <div className="flex border-b border-gray-800 mb-5 -mt-2">
          <button className={tabBtn('settings', 'System settings')} onClick={() => setTab('settings')}>System settings</button>
          <button className={tabBtn('users', 'Users')} onClick={() => setTab('users')}>Users</button>
        </div>

        {tab === 'settings' && (
          <div className="flex flex-col gap-6">

            {/* Memory */}
            <div className="flex flex-col gap-3">
              <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Memory</p>
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-gray-400 font-medium">Token budget</p>
                <p className="text-xs text-gray-500">Max tokens injected from space memories into the system prompt.</p>
                <input type="number" min={100} max={10000} step={100} value={budgetDraft}
                  onChange={e => setBudgetDraft(e.target.value)}
                  className="w-32 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
              <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-3">
                <p className="text-xs text-gray-400 font-medium">User memory budget</p>
                <p className="text-xs text-gray-500">Max tokens injected from a user&apos;s <em>About you</em> memories, in every chat whether it belongs to a space or not. Applies only to users who enabled the setting; 0 disables the feature for everyone.</p>
                <input type="number" min={0} max={5000} step={50} value={userMemoryBudgetDraft}
                  onChange={e => setUserMemoryBudgetDraft(e.target.value)}
                  className="w-32 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
              <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-3">
                <p className="text-xs text-gray-400 font-medium">Dream compaction</p>
                <p className="text-xs text-gray-500">Nightly pass that compacts space memories exceeding the threshold down to the target.</p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-gray-500">Hour (server time)</label>
                    <select value={dreamHourDraft} onChange={e => setDreamHourDraft(e.target.value)}
                      className="px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500">
                      <option value="-1">Disabled</option>
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={String(i)}>{String(i).padStart(2, '0')}:00</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-gray-500">Threshold (tokens)</label>
                    <input type="number" min={100} max={50000} step={100} value={dreamThresholdDraft}
                      onChange={e => setDreamThresholdDraft(e.target.value)}
                      className="px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-gray-500">Target (tokens)</label>
                    <input type="number" min={100} max={50000} step={100} value={dreamTargetDraft}
                      onChange={e => setDreamTargetDraft(e.target.value)}
                      className="px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                  </div>
                </div>
                <label className="flex items-center gap-2 mt-1 cursor-pointer w-fit">
                  <input type="checkbox" checked={dreamDeepDraft} onChange={e => setDreamDeepDraft(e.target.checked)}
                    className="accent-blue-500 w-3.5 h-3.5" />
                  <span className="text-xs text-gray-400">Deep dream — re-extract from source conversations using the thinking model</span>
                </label>
                <div className="flex items-center gap-3 mt-1">
                  <button onClick={handleRunDream} disabled={dreamRunning}
                    className="w-fit px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-xs text-gray-200 transition-colors">
                    {dreamRunning ? 'Starting…' : dreamTriggered ? 'Started' : 'Run now'}
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-3">
                <p className="text-xs text-gray-400 font-medium">Extraction context</p>
                <p className="text-xs text-gray-500">
                  Max characters fed to the small model when extracting memories from a chat. The most recent content is kept.
                  {limits && parseInt(extractCharsDraft) > limits.smallModelInputChars && (
                    <> <span className="text-amber-400">Capped at {limits.smallModelInputChars} by the small model's context (SMALL_MODEL_CONTEXT_TOKENS) — values above that have no effect.</span></>
                  )}
                </p>
                <input type="number" min={500} max={100000} step={500} value={extractCharsDraft}
                  onChange={e => setExtractCharsDraft(e.target.value)}
                  className="w-32 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
              <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-3">
                <p className="text-xs text-gray-400 font-medium">RAG context budget (tokens)</p>
                <p className="text-xs text-gray-500">Extra tokens injected via semantic search: relevant past memories not in the fixed block, plus excerpts from files tagged to the space. Set to 0 to disable. Memory RAG is prioritised over file excerpts.</p>
                <input type="number" min={0} max={10000} step={100} value={spaceRagBudgetDraft}
                  onChange={e => setSpaceRagBudgetDraft(e.target.value)}
                  className="w-32 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
                <p className="text-xs text-gray-500 mt-1">Re-index all chat sessions across all users. Run this after changing embedding models or dimensions.</p>
                <button onClick={handleReindexChats} disabled={reindexing}
                  className="w-fit px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-xs text-gray-200 transition-colors">
                  {reindexing ? 'Queued…' : reindexResult !== null ? `Queued ${reindexResult} sessions` : 'Re-index chats'}
                </button>
              </div>
            </div>

            {/* Retrieval */}
            <div className="flex flex-col gap-3 border-t border-gray-800 pt-5">
              <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Retrieval</p>
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-gray-400 font-medium">Chunks per search</p>
                <p className="text-xs text-gray-500">How many nearest chunks each vector search retrieves — document RAG, chat history RAG, and the uploads/history search tools. Reranking (below) prunes this list, so it is also the ceiling on what reranking can consider.</p>
                <input type="number" min={1} max={100} step={1} value={ragTopKDraft}
                  onChange={e => setRagTopKDraft(e.target.value)}
                  className="w-24 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
            </div>

            {/* Reranking */}
            <div className="flex flex-col gap-3 border-t border-gray-800 pt-5">
              <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Reranking</p>
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-gray-400 font-medium">Top N results</p>
                <p className="text-xs text-gray-500">Number of search results kept after reranking. Only applies when a reranker model is configured.</p>
                <input type="number" min={1} max={100} step={1} value={rerankTopNDraft}
                  onChange={e => setRerankTopNDraft(e.target.value)}
                  className="w-24 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
            </div>

            {/* Search */}
            <div className="flex flex-col gap-3 border-t border-gray-800 pt-5">
              <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Search</p>
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-gray-400 font-medium">Query reformulation</p>
                <p className="text-xs text-gray-500">Use a small LLM to rewrite queries before searching. Improves relevance but adds latency. Disable on slow hardware.</p>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" checked={queryReformulationDraft} onChange={e => setQueryReformulationDraft(e.target.checked)}
                    className="accent-blue-500 w-3.5 h-3.5" />
                  <span className="text-xs text-gray-400">Enabled</span>
                </label>
              </div>
              <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-3">
                <p className="text-xs text-gray-400 font-medium">RSS feed character budget</p>
                <p className="text-xs text-gray-500">Total characters of news content fetched for a monitor run. Items per feed and content length scale automatically to fit. Increase for large-context models; decrease for small ones (e.g. 8K context ≈ 20 000 chars).</p>
                <input type="number" min={5000} max={500000} step={5000} value={rssFeedCharsBudgetDraft}
                  onChange={e => setRssFeedCharsBudgetDraft(e.target.value)}
                  className="w-32 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
              <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-3">
                <p className="text-xs text-gray-400 font-medium">Max pages per URL</p>
                <p className="text-xs text-gray-500">How many paginated pages to fetch when a user provides a URL (e.g. ?page=2, ?page=3…). Set to 0 for unlimited. Reduce to prevent large sites from flooding the context window.</p>
                <input type="number" min={0} max={50} step={1} value={fetchMaxPagesDraft}
                  onChange={e => setFetchMaxPagesDraft(e.target.value)}
                  className="w-24 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
              <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-3">
                <p className="text-xs text-gray-400 font-medium">Per-URL context cap</p>
                <p className="text-xs text-gray-500">
                  Most characters of a single fetched page that may reach the model, whether the URL was pasted or fetched by the model's own tool. Content above this is summarized or truncated per the setting below. A page is scraped up to {limits?.scrapeMaxChars ?? 100000} chars (FETCH_MAX_CHARS), so raising this beyond that has no effect.
                </p>
                <input type="number" min={limits?.minUrlContextChars ?? 8000} max={limits?.scrapeMaxChars ?? 100000} step={5000} value={fetchMaxUrlContextCharsDraft}
                  onChange={e => setFetchMaxUrlContextCharsDraft(e.target.value)}
                  className="w-32 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
              <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-3">
                <p className="text-xs text-gray-400 font-medium">Summarize oversized URL content</p>
                <p className="text-xs text-gray-500">When fetched URL content exceeds the per-URL cap above, use the small model to summarize it instead of hard-truncating. Produces better results but adds latency. Requires a fast small model. Pages less than 3× the cap are truncated regardless — there is too little to compress for the round trips to pay off.</p>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" checked={fetchSummarizeOverflowDraft} onChange={e => setFetchSummarizeOverflowDraft(e.target.checked)}
                    className="accent-blue-500 w-3.5 h-3.5" />
                  <span className="text-xs text-gray-400">Enabled</span>
                </label>
              </div>
            </div>

            {/* Context */}
            <div className="flex flex-col gap-3 border-t border-gray-800 pt-5">
              <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Context</p>
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-gray-400 font-medium">Compress dropped history</p>
                <p className="text-xs text-gray-500">When a research turn's conversation history must be trimmed to fit the context budget, summarize the dropped messages with the small model and fold the summary into the system prompt instead of discarding them outright. Adds latency; only applies to balanced/thorough research turns.</p>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" checked={compressHistoryOverflowDraft} onChange={e => setCompressHistoryOverflowDraft(e.target.checked)}
                    className="accent-blue-500 w-3.5 h-3.5" />
                  <span className="text-xs text-gray-400">Enabled</span>
                </label>
              </div>
            </div>

            {/* Attachments */}
            <div className="flex flex-col gap-3 border-t border-gray-800 pt-5">
              <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Attachments</p>
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-gray-400 font-medium">Max context characters</p>
                <p className="text-xs text-gray-500">
                  Max characters extracted from an attached file and sent to the chat model as context.
                  {limits && parseInt(attachmentCharsDraft) > limits.embedInputChars && (
                    <> <span className="text-amber-400">The chat model sees all of it, but retrieval only embeds the first {limits.embedInputChars} characters of a message (EMBED_CONTEXT_TOKENS), so a large attachment is not fully searchable from other chats — upload it to the library instead.</span></>
                  )}
                </p>
                <input type="number" min={1000} max={500000} step={1000} value={attachmentCharsDraft}
                  onChange={e => setAttachmentCharsDraft(e.target.value)}
                  className="w-32 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500" />
              </div>
            </div>

            <button
              onClick={handleSaveSettings}
              disabled={savingBudget}
              className="self-start px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium"
            >
              {budgetSaved ? 'Saved ✓' : savingBudget ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}

        {tab === 'settings' && (
          <div className="flex flex-col gap-3 border-t border-gray-800 pt-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Model connectivity</p>
              <button
                onClick={handleTestModels}
                disabled={testingModels}
                className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-xs font-medium"
              >
                {testingModels ? 'Testing…' : 'Test models'}
              </button>
            </div>
            {modelResults && (
              <table className="w-full text-xs">
                <tbody>
                  {modelResults.map(r => (
                    <tr key={r.role} className="border-b border-gray-800/40">
                      <td className="py-1.5 w-16 text-gray-500">{r.role}</td>
                      <td className="py-1.5 w-36 text-gray-300 font-mono truncate">{r.model}</td>
                      <td className="py-1.5 w-8">
                        <span className={r.ok ? 'text-green-400' : 'text-red-400'}>{r.ok ? 'OK' : 'FAIL'}</span>
                      </td>
                      <td className="py-1.5 w-14 text-gray-500 text-right">{r.ms > 0 ? `${r.ms}ms` : ''}</td>
                      <td className="py-1.5 pl-3 text-gray-400 truncate max-w-0 w-full">{r.info}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'users' && (
          <div className="flex flex-col gap-5">
            {/* User list */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Role</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {userList.map(u => (
                  <tr key={u.id} className="border-b border-gray-800/50">
                    <td className="py-2 text-gray-200">{u.email}</td>
                    <td className="py-2 text-gray-400">{u.name ?? '—'}</td>
                    <td className="py-2">
                      {u.id === currentUserId ? (
                        <span className="text-xs text-indigo-400">{u.role}</span>
                      ) : (
                        <button
                          onClick={() => handleRoleToggle(u)}
                          className={`text-xs px-2 py-0.5 rounded ${u.role === 'admin' ? 'bg-indigo-700 hover:bg-indigo-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                        >
                          {u.role}
                        </button>
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => handleResetPassword(u.id)}
                        disabled={busy}
                        className="text-xs text-gray-600 hover:text-amber-400 disabled:opacity-50 mr-3"
                      >
                        Reset password
                      </button>
                      {u.id !== currentUserId && (
                        <button
                          onClick={() => handleDelete(u.id)}
                          className="text-xs text-gray-600 hover:text-red-400"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {tempPassword && (
              <div className="flex flex-col gap-1 border border-amber-700/50 bg-amber-950/30 rounded p-3">
                <p className="text-xs text-amber-300 font-medium">
                  Temporary password for {userList.find(u => u.id === tempPassword.id)?.email ?? 'user'}
                </p>
                <p className="text-xs text-gray-400">
                  Shown once — pass it on securely. They will be asked to set their own password after signing in.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={tempPassword.password}
                    onFocus={e => e.target.select()}
                    className="flex-1 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs font-mono text-gray-100 focus:outline-none"
                  />
                  <button
                    onClick={() => navigator.clipboard.writeText(tempPassword.password)}
                    className="text-xs text-blue-400 hover:underline"
                  >
                    Copy
                  </button>
                  <button onClick={() => setTempPassword(null)} className="text-xs text-gray-500 hover:text-gray-300">
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Invite */}
            <div className="flex flex-col gap-2 border-t border-gray-800 pt-4">
              <p className="text-xs text-gray-400 font-medium">Create invite link</p>
              <div className="flex gap-2">
                <input
                  type="email"
                  placeholder="Email (optional, restricts invite to that address)"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleCreateInvite}
                  disabled={busy}
                  className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium whitespace-nowrap"
                >
                  Generate
                </button>
              </div>
              {inviteUrl && (
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={inviteUrl}
                    className="flex-1 px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 focus:outline-none"
                    onFocus={e => e.target.select()}
                  />
                  <button
                    onClick={() => navigator.clipboard.writeText(inviteUrl)}
                    className="text-xs text-blue-400 hover:underline whitespace-nowrap"
                  >
                    Copy
                  </button>
                </div>
              )}

              {invites.length > 0 && (
                <div className="flex flex-col gap-1 pt-2">
                  <p className="text-xs text-gray-400 font-medium">Outstanding invites</p>
                  {invites.map(i => (
                    <div key={i.token} className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="flex-1 truncate">
                        {i.email ?? 'any email'}
                        <span className="text-gray-600"> · {i.token.slice(0, 8)}… · {inviteStatus(i)}</span>
                      </span>
                      <button
                        onClick={() => handleRevokeInvite(i.token)}
                        disabled={busy}
                        className="text-red-400 hover:underline disabled:opacity-50 whitespace-nowrap"
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
