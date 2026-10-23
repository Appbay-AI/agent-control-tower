import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { captureInstallPrompt } from '@/lib/push'

// The app works offline, so browsers keep a copy. Check for a newer release on load and every
// 30 minutes; when one is found it takes over and the page reloads, so nobody runs an old version.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (registration) setInterval(() => registration.update(), 30 * 60 * 1000)
  },
})

// The browser may offer "Install app" before the Approvals screen is ready to show the button (task 2.6).
captureInstallPrompt()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
