// The root of every surface of the interface (the window, the layer of panels, the mini window, the Settings, the task manager, À propos, the
// Extensions page). React unmounts the whole tree whose render throws: without a boundary at the root, the sidebar and the toolbar vanish until
// Lucium is started again, and the main process never hears of it. Here the failure leaves a plain screen that says so and reloads the
// interface (its page only: the tabs, the pages and the state are the main process'), and every error of the page is written where the main
// process writes its own (Settings › Général › État de Lucium): `[ui]` lines of the console, which main relays (shell/ui-error-relay.ts).

import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { t } from '@shared/i18n'
import { UI_ERROR_PREFIX } from '@shared/ui-errors'
import { UI_ERRORS_LOGGED_MAX, describeUiError, installUiErrorLog } from './ui-error-log'

// The log itself is apart (ui-error-log.ts): a page with no React writes its errors the same way.
export { UI_ERRORS_LOGGED_MAX, describeUiError, installUiErrorLog }

/** The screen of an interface that failed to draw: what happened, and the button that loads it again. */
export function FailedInterface({ reload }: { reload: () => void }) {
  return (
    <div className="root-failed" role="alert">
      <h1>{t('ui.quelque-chose-s-est-mal-passe')}</h1>
      <p>{t('ui.l-interface-n-a-pas-pu-s-afficher')}</p>
      <button type="button" className="root-failed-reload" onClick={reload} autoFocus>
        {t('ui.recharger-l-interface')}
      </button>
    </div>
  )
}

/** The boundary at the root of a surface: a render that throws leaves `FailedInterface`, and the error is written to the log. */
export class RootBoundary extends Component<{ children: ReactNode; reload?: () => void }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${UI_ERROR_PREFIX} the interface failed to draw:`, describeUiError(error), (info.componentStack ?? '').slice(0, 1000))
  }
  override render(): ReactNode {
    return this.state.failed ? <FailedInterface reload={this.props.reload ?? (() => location.reload())} /> : this.props.children
  }
}

/** Mounts a surface in `#root`, inside the boundary, with the log of its errors. */
export function mountRoot(node: ReactNode): void {
  installUiErrorLog()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RootBoundary>{node}</RootBoundary>
    </StrictMode>
  )
}
