import { useState, useEffect } from 'react'
import { listUsers, setUserRole, deleteUser, createInvite, testModels, type ModelTestResult } from '../lib/api.ts'
import { Modal } from './Modal.tsx'

interface Props {
  currentUserId: string
  onClose: () => void
}

type UserRow = { id: string; email: string; name: string | null; role: string; createdAt: number }

export function AdminPanel({ currentUserId, onClose }: Props) {
  const [userList, setUserList] = useState<UserRow[]>([])
  const [inviteUrl, setInviteUrl] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [modelResults, setModelResults] = useState<ModelTestResult[] | null>(null)
  const [testingModels, setTestingModels] = useState(false)

  useEffect(() => {
    listUsers().then(setUserList).catch(() => setError('Failed to load users.'))
  }, [])

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

  async function handleTestModels() {
    setTestingModels(true)
    setModelResults(null)
    try {
      setModelResults(await testModels())
    } finally {
      setTestingModels(false)
    }
  }

  async function handleCreateInvite() {
    setBusy(true)
    try {
      const { token } = await createInvite(inviteEmail || undefined)
      const url = `${window.location.origin}/register?token=${token}`
      setInviteUrl(url)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Admin — Users" onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex flex-col gap-5">
        {error && <p className="text-xs text-red-400">{error}</p>}

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
                <td className="py-2 text-right">
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

        {/* Model test */}
        <div className="flex flex-col gap-2 border-t border-gray-800 pt-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400 font-medium">Model connectivity</p>
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
        </div>
      </div>
    </Modal>
  )
}
