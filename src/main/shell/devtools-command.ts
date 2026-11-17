// A command of the developer tools (menu entry, shortcut) run on a page, and what the user is told when it did not work. Shared by the main
// window, Glance, the mini window and the application windows, which differ only in where a notice can be shown.

import { developerModeOpensTools } from '@shared/developer-mode'
import { devToolsFailureMessage, type DevToolsOutcome, type DevToolsRequest } from '@shared/devtools-request'
import { t } from '@shared/i18n'
import type { Action } from '@shared/sidebar'
import { noteFailure } from './failure-notice'

/** The part of a page this needs (the engine's `Page` fits). */
interface ToolsPage {
  openDevTools(request: DevToolsRequest): Promise<DevToolsOutcome>
}

/** Runs `request` on `page` (none: there is nothing to open the tools on). A failure is written to the journal and said through `notify`. Never rejects. */
export async function runDevTools(page: ToolsPage | undefined, request: DevToolsRequest, notify: (message: string) => void): Promise<void> {
  if (!page) return notify(t('browser.aucune-page-ouverte'))
  let outcome: DevToolsOutcome
  try {
    outcome = await page.openDevTools(request)
  } catch (error) {
    outcome = { ok: false, reason: 'script', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!outcome.ok) noteFailure(`[devtools] "${request}" failed (${outcome.reason}):`, outcome.detail ?? '', notify, devToolsFailureMessage(outcome.reason, request))
}

/** What `applyWithDeveloperTools` needs of the shell. */
export interface DeveloperToolsIo {
  /** The sites with Developer Mode on, as the state holds them now. */
  developerHosts(): readonly string[]
  /** Applies the action to the state. */
  apply(action: Action): void
  /** Shows the developer tools of the page on screen. */
  showTools(): void
}

/**
 * Applies an action of the interface. The Developer Mode row of the site panel, switched on, also shows the tools of the page, but only once the
 * action went through: the list of sites is read before and after, so that a refused action or a site already on opens nothing.
 */
export function applyWithDeveloperTools(action: Action, io: DeveloperToolsIo): void {
  const hostsBefore = io.developerHosts()
  io.apply(action)
  if (developerModeOpensTools(action, hostsBefore, io.developerHosts())) io.showTools()
}
