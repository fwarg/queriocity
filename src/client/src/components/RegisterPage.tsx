import { useState, type FormEvent } from 'react'
import { register } from '../lib/api.ts'
import { useT, useLang } from '../lib/i18n.tsx'
import { errorMessage } from '../lib/errors.ts'
import { LanguageSelect } from './LanguageSelect.tsx'
import { AI_SYSTEM_NOTICE } from '../lib/ai-notice.ts'
import type { AuthUser } from '../lib/api.ts'

interface Props {
  onRegister: (user: AuthUser) => void
  inviteToken?: string          // pre-filled from URL param
  showLoginLink: boolean
  onLogin: () => void
}

export function RegisterPage({ onRegister, inviteToken: initialToken, showLoginLink, onLogin }: Props) {
  const t = useT()
  const { lang, setLang } = useLang()
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
      // The picker's value goes with the request rather than in a PATCH afterwards, so a new
      // account is created already in the language the form was filled in.
      const user = await register(email, password, name || undefined, token || undefined, lang)
      onRegister(user)
    } catch (err: unknown) {
      setError(errorMessage(t, err, t('auth.registerFailed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-950">
      <div className="w-full max-w-sm bg-gray-900 rounded-xl p-8 flex flex-col gap-5 border border-gray-800">
        <div className="flex flex-col gap-1">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl font-semibold text-gray-100">{t('auth.createAccount')}</h1>
            <LanguageSelect value={lang} onChange={setLang} className="py-1 text-xs" />
          </div>
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
            type="text"
            placeholder={t('auth.nameOptional')}
            value={name}
            onChange={e => setName(e.target.value)}
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
          <p className="text-xs text-gray-500">
            {t('auth.passwordRules')}
          </p>
          {!initialToken && (
            <input
              type="text"
              placeholder={t('auth.inviteToken')}
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
            {busy ? t('auth.creatingAccount') : t('auth.createAccount')}
          </button>
        </form>
        {showLoginLink && (
          <p className="text-xs text-gray-500 text-center">
            {t('auth.haveAccount')}{' '}
            <button onClick={onLogin} className="text-blue-400 hover:underline">{t('auth.signIn')}</button>
          </p>
        )}
      </div>
    </div>
  )
}
