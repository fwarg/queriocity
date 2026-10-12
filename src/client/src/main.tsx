import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import 'katex/dist/katex.min.css'
import App from './App.tsx'
import { ConfirmProvider } from './components/confirm.tsx'
import { GuideProvider } from './components/GuideView.tsx'
import { LanguageProvider } from './lib/i18n.tsx'

// A lazily loaded chunk that 404s means the app was redeployed under this page. Reload once per
// session to pick up the new build; the flag stops a genuinely missing file from looping.
const PRELOAD_RELOAD_KEY = 'preload-error-reloaded'
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (sessionStorage.getItem(PRELOAD_RELOAD_KEY)) return
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, '1')
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <ConfirmProvider>
        <GuideProvider>
          <App />
        </GuideProvider>
      </ConfirmProvider>
    </LanguageProvider>
  </StrictMode>
)
