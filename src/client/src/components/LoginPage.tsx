import { useState, type FormEvent } from 'react'
import { login } from '../lib/api.ts'
import type { AuthUser } from '../lib/api.ts'

interface Props {
  onLogin: (user: AuthUser) => void
  showRegisterLink: boolean
  onRegister: () => void
}

export function LoginPage({ onLogin, showRegisterLink, onRegister }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const user = await login(email, password)
      onLogin(user)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-950">
      <div className="w-full max-w-sm bg-gray-900 rounded-xl p-8 flex flex-col gap-5 border border-gray-800">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-gray-100">Sign in to Queriocity</h1>
        </div>
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
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {showRegisterLink && (
          <p className="text-xs text-gray-500 text-center">
            No account?{' '}
            <button onClick={onRegister} className="text-blue-400 hover:underline">
              Register with an invite
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
