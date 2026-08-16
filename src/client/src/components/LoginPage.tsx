import { useState, type FormEvent } from 'react'
import { login } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { AI_SYSTEM_NOTICE } from '../lib/ai-notice.ts'
import type { AuthUser } from '../lib/api.ts'

interface Props {
  onLogin: (user: AuthUser) => void
  showRegisterLink: boolean
  onRegister: () => void
}

export function LoginPage({ onLogin, showRegisterLink, onRegister }: Props) {
  const t = useT()
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
      setError(errorMessage(t, err, t('auth.loginFailed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-950">
      <div className="w-full max-w-sm bg-gray-900 rounded-xl p-8 flex flex-col gap-5 border border-gray-800">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-gray-100">{t('auth.signInTitle')}</h1>
          <p className="text-xs text-gray-500">{t(AI_SYSTEM_NOTICE)}</p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder={t('auth.email')}
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="px-3 py-2 rounded bg-gray-800 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          />
          <input
            type="password"
            placeholder={t('auth.password')}
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
            {busy ? t('auth.signingIn') : t('auth.signIn')}
          </button>
        </form>
        {showRegisterLink && (
          <p className="text-xs text-gray-500 text-center">
            {t('auth.noAccount')}{' '}
            <button onClick={onRegister} className="text-blue-400 hover:underline">
              {t('auth.registerWithInvite')}
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
