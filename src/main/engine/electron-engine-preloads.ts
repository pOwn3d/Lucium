// A layer of the class ElectronEngine (electron-engine.ts; the order of the layers: docs/architecture.md). The preloads of the pages and their channels:
// the media bridge, the alert(), confirm() and prompt() of the pages, window.chrome.app, the password bridge, the shims of the extensions and the patches of the library.

import { ipcMain, type Session, type IpcMainEvent, type WebContents } from 'electron'
import { MEDIA_BRIDGE } from '@shared/media-player'
import { Channel } from '@shared/ipc-channels'
import { replyOnce, withoutBoxReplyOf, type DialogReply, type PageDialogKind } from '@shared/page-dialog'
import { PASSWORD_BRIDGE } from '@shared/passwords'
import { isMainFrameSender } from '@shared/surface-guard'
import { addBounded } from '@shared/bounded'
import { SIGN_IN_PRELOAD_EXCLUDES } from '@shared/google-sign-in'
import { ElectronPage } from './electron-page'
import { EXTENSION_FRAME_MATCHES, registerLimitedPreload } from './extension-runtime'
import { SHIM_CALL_CHANNEL, shimsPreloadPath, dialogBridgePath, chromeAppPath, lentTabPath, passwordBridgePath, WORKERS_MAX } from './electron-engine-base'
import { ElectronEngineBridge } from './electron-engine-bridge'

export abstract class ElectronEnginePreloads extends ElectronEngineBridge {
  /** Loads the dialog bridge (src/preload/dialog-bridge.ts: `alert()`, `confirm()`, `prompt()`) into the main frame of every page the session opens from now on. */
  protected installDialogBridge(ses: Session): void {
    if (this.dialogSessions.has(ses)) return
    this.dialogSessions.add(ses)
    ses.registerPreloadScript({ id: 'lucium-dialog-bridge', type: 'frame', filePath: dialogBridgePath(), excludeMatches: [...SIGN_IN_PRELOAD_EXCLUDES] })
  }

  /**
   * Loads `window.chrome.app` (src/preload/chrome-app.ts) into the pages the session opens from now on. Chromium-based browsers have it, Electron does not, and Google's sign-in refuses
   * a browser without it ("Impossible de vous connecter: ce navigateur ou cette application ne sont peut-être pas sécurisés"); with it alone the
   * same page accepts the address it is given.
   */
  protected installChromeApp(ses: Session): void {
    if (this.chromeAppSessions.has(ses)) return
    this.chromeAppSessions.add(ses)
    ses.registerPreloadScript({ id: 'lucium-chrome-app', type: 'frame', filePath: chromeAppPath(), excludeMatches: [...SIGN_IN_PRELOAD_EXCLUDES] })
  }

  /** Registers or takes away the password bridge in a profile's session so that it matches `passwordBridgeOn`. A private context's session never comes here. */
  protected syncPasswordBridge(ses: Session): void {
    const has = this.passwordSessions.has(ses)
    if (this.passwordBridgeOn && !has) {
      ses.registerPreloadScript({ id: 'lucium-password-bridge', type: 'frame', filePath: passwordBridgePath() })
      this.passwordSessions.add(ses)
    } else if (!this.passwordBridgeOn && has) {
      ses.unregisterPreloadScript('lucium-password-bridge')
      this.passwordSessions.delete(ses)
    }
  }

  setPasswordBridge(on: boolean): void {
    if (on === this.passwordBridgeOn) return
    this.passwordBridgeOn = on
    // The listener exists only while the manager is on: off, the channel has no one behind it.
    if (on) ipcMain.on(PASSWORD_BRIDGE.submitted, this.onPasswordSubmitted)
    else ipcMain.removeListener(PASSWORD_BRIDGE.submitted, this.onPasswordSubmitted)
    for (const { session: ses } of this.profiles.values()) this.syncPasswordBridge(ses)
  }

  /**
   * The media player is switched on or off (Settings › Fonctions): the bridge goes into the pages of every session that exists, or leaves them.
   * Off, no session carries the script, so no page gets it from its next document on, and the two channels it talks over are not served.
   */
  setMediaBridge(on: boolean): void {
    this.mediaBridge.set(on, this.liveSessions())
    this.listenToMediaBridge(on)
  }

  /** The sessions pages can be in now: the profiles' and the private windows'. */
  private liveSessions(): Session[] {
    return [...[...this.profiles.values()].map((p) => p.session), ...[...this.scopes.values()].map((scope) => scope.session)]
  }

  /**
   * The level of a tab for a new document, and the track actions of a site. Only a page of ours is answered or heard (a preload runs in the
   * main frame of a page only: Electron does not load it into frames).
   */
  protected listenToMediaBridge(on: boolean): void {
    if (on === (this.stopMediaChannels !== null)) return
    if (!on) {
      this.stopMediaChannels?.()
      this.stopMediaChannels = null
      return
    }
    // The main frame only, as for the other bridges: the day a preload runs in the frames too, a frame of another site must not speak for the page.
    const actions = (event: IpcMainEvent, raw: unknown): void => (isMainFrameSender(event) ? this.pageOfContents(event.sender) : undefined)?.reportTrackActions(raw)
    ipcMain.handle(MEDIA_BRIDGE.hello, (event) => (isMainFrameSender(event) ? this.pageOfContents(event.sender) : undefined)?.tabVolume() ?? 1)
    ipcMain.on(MEDIA_BRIDGE.actions, actions)
    const pip = (event: IpcMainEvent): void => (isMainFrameSender(event) ? this.pageOfContents(event.sender) : undefined)?.sitePictureInPicture?.()
    ipcMain.on(MEDIA_BRIDGE.pip, pip)
    this.stopMediaChannels = () => {
      ipcMain.removeListener(MEDIA_BRIDGE.pip, pip)
      ipcMain.removeHandler(MEDIA_BRIDGE.hello)
      ipcMain.removeListener(MEDIA_BRIDGE.actions, actions)
    }
  }

  /**
   * A call of `alert()`, `confirm()` or `prompt()` of a page (src/preload/dialog-bridge.ts), on the channel of `kind`. The page waits for the reply,
   * so every message is answered. Only the main frame of a page of ours is heard; anything else keeps the page's own function (Electron's sheet for
   * `alert()` and `confirm()`, null for `prompt()`).
   */
  protected pageDialog(kind: PageDialogKind, event: IpcMainEvent, raw: unknown): void {
    const reply = replyOnce<DialogReply>(
      (value) => {
        event.returnValue = value
      },
      (error) => console.warn('[dialog] the page that asked for a box could not be answered:', error instanceof Error ? error.message : String(error))
    )
    const page = isMainFrameSender(event) ? this.pageOfContents(event.sender) : undefined
    if (!page) {
      console.warn(`[dialog] refused a call of ${kind}() that does not come from the main frame of a tab`)
      reply(withoutBoxReplyOf(kind))
      return
    }
    let frameUrl = ''
    try {
      frameUrl = event.senderFrame?.url ?? ''
    } catch (error) {
      // The frame went away between the message and now: its page is not one that may ask (the empty address is refused).
      console.warn('[dialog] the frame that asked for a box is gone:', error instanceof Error ? error.message : String(error))
    }
    try {
      page.askDialog(kind, raw, frameUrl, reply)
    } catch (error) {
      // A bug on our side must not leave the page blocked for ever: it gets its own function, as before the bridge.
      console.error(`[dialog] cannot handle a call of ${kind}():`, error instanceof Error ? error.message : String(error))
      reply(withoutBoxReplyOf(kind))
    }
  }

  protected pageOfContents(contents: WebContents): ElectronPage | undefined {
    const id = this.pageByContents.get(contents.id)
    return id === undefined ? undefined : this.pages.get(id)
  }

  protected installShims(ses: Session, profileId: string): void {
    const filePath = shimsPreloadPath()
    ses.registerPreloadScript({ id: 'lucium-shims-sw', type: 'service-worker', filePath })
    this.registerFrameShims(ses, 'lucium-shims-frame', filePath)
    // The runtime of the scripts an extension injects into a tab the user lent it with a click (src/preload/lent-tab.ts): in the sessions that load an extension, and in the pages of the web only.
    // It does nothing until the main process asks for it for a lent tab (engine/lent-tabs.ts). A page loaded before the extension has none, and its script runs with the page alone.
    registerLimitedPreload(ses, { id: 'lucium-lent-tab', type: 'frame', filePath: lentTabPath(), matches: ['http://*/*', 'https://*/*'] }, (error) =>
      console.error('[extensions] the script of the lent tabs could not be limited to the pages of the web; it runs in every page, as before:', error)
    )
    ses.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
      // A worker that stops takes its ports with it (a native port lives as long as the context that opened it).
      if (runningStatus === 'stopping' || runningStatus === 'stopped') {
        // What a script of a lent tab asked this worker and it has not answered is not going to be answered: the listener that held it goes with the worker.
        const scope = ses.serviceWorkers.getWorkerFromVersionID(versionId)?.scope
        if (scope?.startsWith('chrome-extension://')) this.lentAsks.workerGone(profileId, new URL(scope).host)
        // The request listeners of the worker are kept aside: a request they cover starts it again (extension-net.ts).
        this.extensionNets.get(ses)?.contextGone(`worker:${versionId}`)
        return this.contextGone({ context: `worker:${versionId}` })
      }
      if (runningStatus !== 'starting') return
      const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId)
      if (!worker || !worker.scope.startsWith('chrome-extension://') || this.extensionWorkers.has(worker)) return
      // A worker that is gone is not kept (a service worker starts and stops all day long).
      for (const known of this.extensionWorkers) if (known.isDestroyed()) this.extensionWorkers.delete(known)
      addBounded(this.extensionWorkers, worker, WORKERS_MAX)
      this.workerProfile.set(worker, profileId)
      const run = `worker:${versionId}`
      const senderId = new URL(worker.scope).host
      worker.ipc.handle(SHIM_CALL_CHANNEL, (_event, extensionId: string, api: string, method: string, args: unknown[]) =>
        this.dispatchShim(senderId, profileId, extensionId, api, method, args, run)
      )
      // The sound of a tab (chrome.tabCapture): the extension is the one the worker belongs to. A worker has no page to give a stream to, so it claims nothing.
      const asker = { extensionId: senderId, profileId, context: run }
      worker.ipc.handle(Channel.extTabCaptureId, (_event, raw: unknown) => this.tabCaptures.id(asker, raw))
      worker.ipc.handle(Channel.extTabCaptureList, () => this.tabCaptures.list(asker))
    })
  }

  /**
   * The same preload again, registered once the extension library has registered its own: the script tells by itself that it runs
   * after the library, and then replaces what the library got wrong instead of defining what it lacks.
   */
  protected installPatches(ses: Session): void {
    const filePath = shimsPreloadPath()
    ses.registerPreloadScript({ id: 'lucium-patches-sw', type: 'service-worker', filePath })
    this.registerFrameShims(ses, 'lucium-patches-frame', filePath)
  }

  /**
   * The shims for the frames, in the pages of extensions only: the script does nothing in any other document (it returns at its first line
   * there), so a web page no longer reads and compiles it. An Electron that refuses the limit gets it in every document, as before.
   */
  private registerFrameShims(ses: Session, id: string, filePath: string): void {
    registerLimitedPreload(ses, { id, type: 'frame', filePath, matches: [...EXTENSION_FRAME_MATCHES] }, (error) =>
      console.error(`[extensions] the script ${id} could not be limited to the pages of extensions; it runs in every page, as before:`, error)
    )
  }
}
