// The quit of the application, as main() (index.ts) installs it once its windows exist: the watch of a quit the system asks for, the last
// writes of `will-quit`, the question of "Avertir avant de quitter" and the erasure "à la fermeture de Lucium" on `before-quit`. The order of the
// handlers is the order they run in, and it matters: the erasure does nothing while the question holds the quit (`event.defaultPrevented`), and
// the writes of `will-quit` come after every other `will-quit` handler of main(), so this is installed after them.

import type { App, Dialog } from 'electron'
import { quitClearStep, quitDialogHost, quitQuestion, quitStep } from '@shared/quit-decision'
import { windowTabCount } from '@shared/window-close'
import { quitClearPending } from '@shared/site-clear'
import { t } from '@shared/i18n'
import { SystemQuit, quitAndExit, type SystemQuitDeps } from './system-quit'
import { finishQuitClear, markQuitClear } from './quit-clear'
import type { StateStore } from '../store'
import type { WindowManager } from './windows'
import type { Browser } from './browser'

/** How long quitting waits for the erasure of the sites "à la fermeture de Lucium". */
export const QUIT_CLEAR_TIMEOUT_MS = 8000

export interface QuitFlowDeps {
  app: Pick<App, 'on' | 'quit' | 'exit'>
  dialog: Pick<Dialog, 'showMessageBox'>
  proc: SystemQuitDeps['proc']
  power: SystemQuitDeps['power']
  store: Pick<StateStore, 'get' | 'flush' | 'dispatch'>
  history: { flush(): void }
  engine: { flushDownloadResume(): void; flushStrictTransport(): void }
  windowManager: Pick<WindowManager, 'list' | 'privateWindows' | 'focused' | 'markQuitting'>
  browser: Pick<Browser, 'clearSitesOnQuit'>
  smoke: boolean
  /** The marker of an erasure under way (shell/quit-clear.ts): main() replays one the last quit cut short. */
  quitClearMarker: string
  /** Makes the copy of the session "À la fermeture" (shell/backups.ts): for the forced exit, which skips the `will-quit` it is made on. */
  copyOnExit(): void
  /** Removes the sign of a clean exit (shell/clean-exit.ts): the run ends the way it is meant to, by `will-quit` or by the forced exit that saves first. */
  markCleanExit(): void
  /** Whether the quit goes ahead without the question: main() keeps it, as the last window closed confirms it too. */
  confirmed(): boolean
  confirm(): void
}

/**
 * "Installer et relancer" (autoUpdater.quitAndInstall, shell/app-update.ts): Electron emits `before-quit-for-update`, closes every window, and only
 * then quits, so `before-quit` comes after the windows are gone. Nothing may hold that quit: the question of "Avertir avant de quitter" (and the one
 * about downloads in progress) is answered, and the windows are marked as closing for the quit, so that the question before closing a window of
 * several tabs is not asked and the memory of the windows keeps them. The state is written now, before the windows close. Electron emits the event
 * again once the windows are closed: doing it twice changes nothing. The erasure of the sites "à la fermeture de Lucium" still runs on `before-quit`
 * (8 s at most), then quits.
 */
export function prepareQuitForUpdate(deps: Pick<QuitFlowDeps, 'store' | 'history' | 'engine' | 'windowManager' | 'confirm'>): void {
  deps.confirm()
  deps.windowManager.markQuitting()
  deps.store.flush()
  deps.history.flush()
  deps.engine.flushDownloadResume()
  deps.engine.flushStrictTransport()
}

/** Installs the quit; answers the watch of a quit the system asks for. */
export function installQuitFlow(deps: QuitFlowDeps): SystemQuit {
  const { app, dialog, store, history, engine, windowManager, browser, smoke, quitClearMarker } = deps
  // A quit the system asks for (SIGTERM, SIGINT, SIGHUP, shutdown, restart, logout) is never held for a question nobody is there to answer: it saves and goes
  // (shell/system-quit.ts, shared/quit-decision.ts). ⌘Q and the Dock's Quit keep the question below.
  const systemQuit = new SystemQuit({
    proc: deps.proc,
    power: deps.power,
    // `quit` saves, then quits; `exit`, for the quit that did not finish in time, makes the same saves and the copy of the session, then the process ends without its will-quit.
    ...quitAndExit({ store, history, engine }, app, () => {
      deps.copyOnExit()
      deps.markCleanExit()
    }),
    log: (line) => console.log(line)
  })
  systemQuit.start()
  app.on('will-quit', () => systemQuit.stop())
  // The last word of the quit: the windows closed after the flush of before-quit, and what their closing changed (a dispatch arms a timer
  // the process no longer waits for) is written now. Registered after every other will-quit handler of main(), so that it runs after them.
  app.on('will-quit', () => {
    store.flush()
    history.flush()
    // An answer that came while the windows closed may have named one more host held to strict transport security.
    engine.flushStrictTransport()
    // Everything is written: this run ends cleanly (a crash before this point leaves the sign, and the next launch offers « Reprendre où vous en étiez ? »).
    deps.markCleanExit()
  })

  // "Warn before quitting": ask once, then really quit. The engine test exits through app.exit and never gets here.
  let asking = false
  app.on('before-quit', (event) => {
    const downloadsInProgress = (): number => windowManager.list().flatMap((w) => w.browser.snapshot().downloads).filter((d) => d.state === 'progressing').length
    // Downloads in progress are always worth a question; the generic one can be switched off. Once the quit goes ahead, the windows close without the question about closing a window.
    if (quitStep({ confirmed: deps.confirmed(), system: systemQuit.isActive(), warnBeforeQuitting: store.get().settings.warnBeforeQuitting, downloading: downloadsInProgress }) === 'go') return windowManager.markQuitting()
    event.preventDefault()
    if (asking) return
    asking = true
    // What quitting loses (downloads, private tabs) makes "Annuler" the default button: see quitQuestion.
    const privateTabs = windowManager.privateWindows().reduce((sum, w) => sum + windowTabCount(w.store.get(), 'private'), 0)
    const { offersNeverAsk, ...question } = quitQuestion({ downloading: downloadsInProgress(), privateTabs })
    const options = { ...question, ...(offersNeverAsk ? { checkboxLabel: t('app.quitter-et-ne-plus-demander'), checkboxChecked: false } : {}) }
    // Hung from a window that can be seen: a question hung from a hidden one is never answered, and the quit waits for it for ever.
    const records = windowManager.list()
    const hostId = quitDialogHost(records.map((r) => ({ id: r.id, destroyed: r.win.isDestroyed(), visible: r.win.isVisible() && !r.win.isMinimized() })), windowManager.focused().id)
    const host = records.find((r) => r.id === hostId)?.win
    const shown = host ? dialog.showMessageBox(host, options) : dialog.showMessageBox(options)
    void shown
      .then(({ response, checkboxChecked }) => {
        if (response !== 0) return
        if (checkboxChecked) store.dispatch({ type: 'settings/update', patch: { warnBeforeQuitting: false } })
        deps.confirm()
        app.quit()
      })
      .catch((error: unknown) => console.error('[quit] the confirmation could not be shown:', error))
      .finally(() => {
        asking = false
      })
  })

  // Settings › Confidentialité › "Aussi à la fermeture de Lucium": the data of the listed sites goes before the application ends. The quit is held
  // for it, for a few seconds at most: a site that does not answer must not keep the application open. Never while the confirmation above is pending.
  let clearedOnQuit = false
  app.on('before-quit', (event) => {
    if (clearedOnQuit || smoke || event.defaultPrevented || !quitClearPending(store.get(), { private: false })) return
    // Written before the erasure, removed once it is whole: a quit that cut it short leaves the marker, and the next launch does the rest.
    markQuitClear(quitClearMarker)
    // A quit the system asked for waits for nobody: the marker stays and the next launch erases (replayQuitClear in index.ts).
    if (quitClearStep({ system: systemQuit.isActive() }) === 'defer') {
      clearedOnQuit = true
      return
    }
    event.preventDefault()
    const patience = new Promise<string[]>((resolve) => setTimeout(() => resolve(['(délai dépassé)']), QUIT_CLEAR_TIMEOUT_MS).unref())
    void Promise.race([browser.clearSitesOnQuit(), patience])
      .then((failed) => {
        if (failed.length > 0) console.error('[quit] the data of some sites was not erased before quitting:', failed.join(', '))
        else finishQuitClear(quitClearMarker)
      })
      .catch((error: unknown) => console.error('[quit] cannot erase the data of the listed sites:', error))
      .finally(() => {
        clearedOnQuit = true
        deps.confirm()
        app.quit()
      })
  })
  return systemQuit
}
