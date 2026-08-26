import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import 'katex/dist/katex.min.css'
import App from './App.tsx'
import { ConfirmProvider } from './components/confirm.tsx'
import { GuideProvider } from './components/GuideView.tsx'
import { LanguageProvider } from './lib/i18n.tsx'

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
