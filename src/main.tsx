import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { saveComposerDraftFromDom } from './lib/composer-draft'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Prime Work root element was not found')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary
      onCatch={saveComposerDraftFromDom}
      fallback={(
        <div className="empty-state app-error-fallback" role="alert">
          <h2>Prime Work hit an unexpected error</h2>
          <p>Reload to continue. Any message you were typing is preserved.</p>
          <div className="empty-state__action">
            <button type="button" className="button button--primary" onClick={() => window.location.reload()}>Reload Prime Work</button>
          </div>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
