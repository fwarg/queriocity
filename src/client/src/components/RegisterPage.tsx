import { useState, type FormEvent } from 'react'
import { register } from '../lib/api.ts'
import type { AuthUser } from '../lib/api.ts'

interface Props {
  onRegister: (user: AuthUser) => void
  inviteToken?: string          // pre-filled from URL param
  showLoginLink: boolean
  onLogin: () => void
}

export function RegisterPage({ onRegister, inviteToken: initialToken, showLoginLink, onLogin }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [token, setToken] = useState(initialToken ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const user = await register(email, password, name || undefined, token || undefined)
      onRegister(user)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-950">
      <div className="w-full max-w-sm bg-gray-900 rounded-xl p-8 flex flex-col gap-5 border border-gray-800">
        <h1 className="text-xl font-semibold text-gray-100">Create account</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
            className="px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-500">
            Min 8 chars, uppercase, lowercase, digit and special character.
          </p>
          {!initialToken && (
            <input
              type="text"
              placeholder="Invite token"
              value={token}
              onChange={e => setToken(e.target.value)}
              className="px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            />
          )}
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium"
          >
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        {showLoginLink && (
          <p className="text-xs text-gray-500 text-center">
            Already have an account?{' '}
            <button onClick={onLogin} className="text-blue-400 hover:underline">Sign in</button>
          </p>
        )}
      </div>
    </div>
  )
}
