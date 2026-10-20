import { useEffect, useState } from 'react'
import { getMe, hasUsers, logout, type AuthUser } from '../lib/api.ts'

export type AuthView = 'loading' | 'login' | 'register'

/** Who is signed in, and which auth screen to show when nobody is.
 *
 *  On load: an invite link's `?token=` is taken out of the address bar and kept, then the session
 *  cookie is checked. Without a session the screen is registration for an invite or a fresh install
 *  (no users yet), and login otherwise. */
export function useAuth() {
  const [authView, setAuthView] = useState<AuthView>('loading')
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [inviteToken, setInviteToken] = useState<string | undefined>()

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (token) {
      setInviteToken(token)
      window.history.replaceState({}, '', window.location.pathname)
    }
    getMe().then(user => {
      if (user) signedIn(user)
      else if (token) setAuthView('register')
      // Login is the safe guess when the server cannot say: registration needs an invite anyway.
      else hasUsers().then(exists => setAuthView(exists ? 'login' : 'register')).catch(() => setAuthView('login'))
    })
  }, [])

  function signedIn(user: AuthUser) {
    setCurrentUser(user)
    setAuthView('loading')
  }

  async function signOut() {
    await logout()
    setCurrentUser(null)
    setAuthView('login')
  }

  return { authView, setAuthView, currentUser, setCurrentUser, inviteToken, signedIn, signOut }
}
