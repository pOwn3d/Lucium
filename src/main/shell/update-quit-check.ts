// The quit, while an update downloaded in this run waits: Squirrel installs it as Lucium ends (app-update.ts). The feed is read once more first,
// for a few seconds at most, and an update it now lists as withdrawn is dropped. No window is left to say so: the drop is kept in the profile
// (`Settings.updateNotices.dropped`) and the first look of the next launch tells it (auto-update.ts). The quit of « Installer et relancer » is the
// install itself and is not held; a quit the system asks for (shutdown, logout) waits for nobody, as the erasure of quit-flow.ts. With « Rechercher
// les mises à jour automatiquement » off, no request goes out by itself, this one included: the update is installed as it was accepted.

import type { App } from 'electron'
import type { DropOutcome } from '@shared/auto-update'

/** How long the quit waits for the feed. */
export const UPDATE_QUIT_CHECK_MS = 5000

export interface UpdateQuitCheckDeps {
  app: Pick<App, 'on' | 'quit'>
  /** The installer of this run (app-update.ts), or null. */
  installer: () => { isReady(): boolean; isInstalling(): boolean; dropWithdrawn(withdrawn: readonly string[]): Promise<DropOutcome> } | null
  /** Whether the feed may be read without a click (« Rechercher les mises à jour automatiquement »). */
  allowed: () => boolean
  /** The versions the feed of the installer lists as withdrawn, read now; null when it could not be read (the reader says why in the log). */
  withdrawn: () => Promise<readonly string[] | null>
  /** Keeps a drop, for the next launch to tell. */
  remember: (version: string) => void
  /** A quit the system asks for is under way (shell/system-quit.ts). */
  system: () => boolean
  /** The quit was confirmed: asking again when it starts over would be a second question. */
  confirm: () => void
  log: (line: string) => void
  timeoutMs?: number
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Installs the check; after the handlers of quit-flow.ts, so that it waits for their question and their erasure (`defaultPrevented`). */
export function installUpdateQuitCheck(deps: UpdateQuitCheckDeps): void {
  let checked = false
  deps.app.on('before-quit', (event) => {
    const installer = deps.installer()
    if (checked || event.defaultPrevented || !installer?.isReady() || installer.isInstalling() || deps.system()) return
    checked = true
    if (!deps.allowed()) return deps.log('[update] the feed is not read before quitting: the automatic check for updates is off')
    event.preventDefault()
    let timer: ReturnType<typeof setTimeout> | undefined
    const patience = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), deps.timeoutMs ?? UPDATE_QUIT_CHECK_MS)
    })
    void Promise.race([deps.withdrawn(), patience])
      .then(async (withdrawn) => {
        if (withdrawn === 'late' || withdrawn === null) {
          deps.log(`[update] the feed was not read before quitting (${withdrawn === 'late' ? 'no answer in time' : 'no valid answer'}): the downloaded update is installed as it is`)
          return
        }
        const outcome = await installer.dropWithdrawn(withdrawn)
        // A drop that failed is in the log (app-update.ts): Squirrel may install the update, and the next launch, running it, is told it was withdrawn.
        if (outcome.kind === 'dropped') deps.remember(outcome.version)
      })
      .catch((error: unknown) => deps.log(`[update] the feed could not be checked before quitting: ${words(error)}`))
      .finally(() => {
        clearTimeout(timer)
        deps.confirm()
        deps.app.quit()
      })
  })
}

export interface PrepareBeforeQuitDeps {
  app: Pick<App, 'on' | 'quit'>
  /** The installer of this run (app-update.ts), or null. */
  installer: () => { isReady(): boolean; isInstalling(): boolean; prepareInstall(): Promise<void> } | null
  /** A quit the system asks for is under way (shell/system-quit.ts). */
  system: () => boolean
  /** The quit was confirmed: asking again when it starts over would be a second question. */
  confirm: () => void
  log: (line: string) => void
}

/**
 * The quit that installs a downloaded update: Squirrel replaces the application as Lucium ends, so what must be done before (the custom icon taken
 * off the bundle, app-icon.ts) is done first, and the quit goes on whatever comes of it. Installed after `installUpdateQuitCheck`, so that it waits
 * for its look at the feed: an update dropped meanwhile is not installed, and nothing is done for it. « Installer et relancer » did it before its
 * quit (app-update.ts, `restart`); a quit the system asks for waits for nobody. A quit without an update that waits holds nothing.
 */
export function installPrepareBeforeQuit(deps: PrepareBeforeQuitDeps): void {
  let prepared = false
  deps.app.on('before-quit', (event) => {
    const installer = deps.installer()
    if (prepared || event.defaultPrevented || !installer?.isReady() || installer.isInstalling() || deps.system()) return
    prepared = true
    event.preventDefault()
    void installer
      .prepareInstall()
      .catch((error: unknown) => deps.log(`[update] the application could not be prepared for the installation before quitting: ${words(error)}`))
      .finally(() => {
        deps.confirm()
        deps.app.quit()
      })
  })
}
