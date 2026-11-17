// A layer of the class ElectronEngine (electron-engine.ts; the order of the layers: docs/architecture.md). The bridge between the extensions and the tabs:
// the window the user is in, the hooks of the shell, the clipboard, the chrome.* shims, the relayed events, the facts of a tab.

import { readFile, stat } from 'node:fs/promises'
import { app, clipboard, ClipboardItem, WebContentsView, type Session, type WebContents, webContents as allWebContents, webFrameMain } from 'electron'
import { isRelayedEvent, lifecycleEvents, relayScript, shimAllowed, shimEventAllowed } from '@shared/chrome-compat'
import { accessOf, canCaptureTab, canReadTab, hasHostAccess } from '@shared/extension-access'
import { callOf, guardedScript, lentOrigin, lentTab, NO_PAGE_ACCESS, readInjection, refusedByDocument, SCRIPT_MAX_CHARS } from '@shared/active-tab-script'
import { setBounded } from '@shared/bounded'
import { Channel } from '@shared/ipc-channels'
import { updateContextMenuItem } from './ece-router'
import { insideFolder } from './extension-net'
import { TabCaptures, type TabCaptureEvent } from './tab-capture'
import { LENT_PAYLOAD_MAX, sizeAtMost } from '@shared/lent-tab-runtime'
import { LentAsks } from './lent-asks'
import { LentTabs } from './lent-tabs'
import { openCaptureHelper } from './tab-capture-helper'
import { captureHelperLoadHeader } from './internal-pages'
import type { ActionMenuEntry, ShimHandler, TabFacts } from './types'
import { SHIM_EVENT_CHANNEL, EXTENSION_LOG, LOG_START } from './electron-engine-base'
import { ElectronEngineBase } from './electron-engine-base'

export abstract class ElectronEngineBridge extends ElectronEngineBase {
  /** The extensions the person let capture the sound of a tab, by profile (`configureExtensions`). None until the shell says. */
  protected tabCaptureAllowed = new Map<string, Set<string>>()
  /** The whole function is on (the setting): on until the shell says otherwise, as the setting is. */
  protected tabCaptureOn = true

  /** The sound of a tab for the extensions: who may ask, what the page is given, how it ends (tab-capture.ts, shared/tab-capture.ts). */
  protected readonly tabCaptures: TabCaptures = this.makeTabCaptures()

  private makeTabCaptures(): TabCaptures {
    const contentsOf = (tabNumber: number): WebContents | undefined => {
      const wc = allWebContents.fromId(tabNumber)
      return wc && !wc.isDestroyed() ? wc : undefined
    }
    const captures = new TabCaptures({
      manifestOf: (profileId, extensionId) => (this.loaded.has(`${profileId}:${extensionId}`) ? this.manifests.get(`${profileId}:${extensionId}`) : undefined),
      nameOf: (profileId, extensionId) => this.known.get(`${profileId}:${extensionId}`)?.info.name ?? extensionId,
      featureOn: () => this.tabCaptureOn,
      allowed: (profileId, extensionId) => this.tabCaptureAllowed.get(profileId)?.has(extensionId) === true,
      tab: (tabNumber) => {
        const profileId = this.profileOfTab(tabNumber)
        const url = this.tabUrl(tabNumber)
        return profileId !== undefined && url !== undefined ? { profileId, url } : undefined
      },
      shownTab: (profileId) => this.lastActivated.get(profileId),
      locked: (tabNumber) => this.hooks?.tabLocked?.(tabNumber) === true,
      lent: (extensionId, tabNumber, url) => this.activeTabs.has(extensionId, tabNumber, url),
      revoke: (extensionId, tabNumber) => this.activeTabs.revoke(extensionId, tabNumber),
      muted: (tabNumber) => contentsOf(tabNumber)?.isAudioMuted(),
      setMuted: (tabNumber, muted) => contentsOf(tabNumber)?.setAudioMuted(muted),
      // The whole web contents is captured, whichever frame is named: the main frame is the page.
      targetFrame: (tabNumber) => contentsOf(tabNumber)?.mainFrame ?? null,
      // In the session of the profile, as the tab it listens to is: a stream is handed to a page of the session its source is in.
      openHelper: (profileId) => {
        const profile = this.profiles.get(profileId)
        if (!profile) return null
        // The session of a profile serves the page of the helper to the load that carries its secret: a session that does not has none, and no helper is made.
        const loadHeader = captureHelperLoadHeader(profile.session)
        if (loadHeader === null) {
          console.warn(`[tab-capture] the session of the profile ${profileId} does not serve the helper page: the capture is refused`)
          return null
        }
        return openCaptureHelper(profile.session, { gone: (contentsId) => captures.helperGone(contentsId), warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail)) }, loadHeader)
      },
      deliver: (frame, claimId, chunk) => {
        const target = webFrameMain.fromId(frame.processId, frame.routingId)
        if (!target) throw new Error('the page that listens is gone')
        target.send(Channel.extTabCapturePcm, claimId, chunk)
      },
      tellStop: (frame, claimId) => webFrameMain.fromId(frame.processId, frame.routingId)?.send(Channel.extTabCaptureStop, claimId),
      forceEnd: (contentsId) => allWebContents.fromId(contentsId)?.reload(),
      warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail))
    })
    // What a capture holds ends with the page that listens, with the tab, and with the application.
    this.contextGoneListeners.push((gone) => {
      const contentsId = gone.context?.startsWith('frame:') ? Number(gone.context.slice('frame:'.length)) : NaN
      if (Number.isSafeInteger(contentsId)) captures.contentsGone(contentsId)
      else if (gone.extensionId !== undefined && gone.profileId !== undefined) captures.extensionGone(gone.profileId, gone.extensionId)
    })
    this.tabClosedListeners.push((tabNumber) => captures.tabGone(tabNumber))
    app.on('will-quit', () => captures.shutdown())
    return captures
  }

  /** What the workers were asked for the scripts of lent tabs and have not answered yet: bounded, and ended with the tab, the worker or the extension (lent-asks.ts). */
  protected readonly lentAsks: LentAsks = new LentAsks((profileId, extensionId, id, op, payload) => this.deliverToWorker(extensionId, profileId, 'lentTab', 'ask', [id, op, payload]))

  /** The runtime of the scripts an extension injects into a tab the user lent it with a click: `chrome.runtime`, `chrome.storage` and the messages (lent-tabs.ts, shared/lent-tab-runtime.ts). */
  protected readonly lentTabs: LentTabs = this.makeLentTabs()

  private makeLentTabs(): LentTabs {
    const lents = new LentTabs({
      contents: (tabNumber) => {
        const wc = allWebContents.fromId(tabNumber)
        return wc && !wc.isDestroyed() ? wc : undefined
      },
      lentProfile: (extensionId, tabNumber) => {
        const profileId = this.profileOfTab(tabNumber)
        const manifest = profileId !== undefined && this.loaded.has(`${profileId}:${extensionId}`) ? this.manifests.get(`${profileId}:${extensionId}`) : undefined
        return profileId !== undefined && manifest !== undefined && lentTab(accessOf(manifest).permissions, this.activeTabs, extensionId, tabNumber, this.tabUrl(tabNumber)) ? profileId : undefined
      },
      extensionOfWorld: (world) => this.scriptWorlds.extensionOf(world),
      worldOf: (extensionId) => this.scriptWorlds.of(extensionId),
      details: (profileId, extensionId) => {
        const key = `${profileId}:${extensionId}`
        const manifest = this.loaded.has(key) ? this.manifests.get(key) : undefined
        return manifest === undefined ? undefined : { permissions: accessOf(manifest).permissions, manifest: this.known.get(key)?.manifest ?? manifest }
      },
      askWorker: (profileId, extensionId, tabNumber, op, payload, characters) => this.lentAsks.ask(profileId, extensionId, tabNumber, op, payload, characters),
      mayAsk: (profileId, extensionId, characters) => this.lentAsks.canKeep(profileId, extensionId, characters),
      dropAsks: (tabNumber) => this.lentAsks.tabGone(tabNumber),
      warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail))
    })
    this.tabClosedListeners.push((tabNumber) => lents.tabGone(tabNumber))
    // An extension that is unloaded from a profile is asked nothing more, and what it was asked is not answered.
    this.contextGoneListeners.push((gone) => {
      if (gone.context === undefined && gone.extensionId !== undefined && gone.profileId !== undefined) this.lentAsks.extensionGone(gone.profileId, gone.extensionId)
    })
    return lents
  }

  /**
   * The calls of the workers and the pages of an extension about the scripts it runs in lent tabs (src/preload/lent-tab-agent.ts): `answer` is the reply to what a worker was asked, only from a worker
   * of the extension that was asked; `toTab` is a message for a script of a lent tab, which Chromium could not deliver; `changed` is a change of the storage the scripts are told.
   */
  private lentTabCall(profileId: string, extensionId: string, method: string, args: unknown[], context: string): unknown {
    switch (method) {
      case 'answer': {
        // What a worker answers is of any size and any shape (it is its own): its size is counted here, without writing it out, and an answer that is too long is replaced by an error.
        if (context.startsWith('worker:')) this.lentAsks.answer(profileId, extensionId, args[0], args[1], sizeAtMost(args[1], LENT_PAYLOAD_MAX))
        return undefined
      }
      case 'toTab': {
        const options = typeof args[2] === 'object' && args[2] !== null ? (args[2] as { frameId?: unknown }) : undefined
        if (!Number.isInteger(args[0])) throw new Error(`No tab with id: ${String(args[0])}.`)
        return this.lentTabs.toTab(profileId, extensionId, args[0] as number, args[1], args[3], options?.frameId)
      }
      case 'changed':
        this.lentTabs.changed(profileId, extensionId, args[1], args[0])
        return undefined
      default:
        throw new Error(`chrome.lentTab.${method} is not provided.`)
    }
  }

  onTabCapture(listener: (event: TabCaptureEvent) => void): void {
    this.tabCaptures.onChange(listener)
  }

  stopTabCapture(tabNumber: number): boolean {
    return this.tabCaptures.stop(tabNumber)
  }

  reconsiderTabCaptures(): void {
    this.tabCaptures.reconsider()
  }

  /**
   * A window of the application took the focus: the extension runtime of every profile is told that it is the window the user is in. The library learns of a focus only
   * for a window that already has a page of its profile, so without this a new window the user starts working in is not "the current window" of any extension until the
   * user has left it and come back. The popup of an icon, Settings and the mini windows take the focus too and are none of that.
   */
  protected followFocusedWindow(windowId: number): void {
    if (this.hooks?.hasWindow?.(windowId) !== true) return
    this.currentWindowId = windowId
    for (const profile of this.profiles.values()) profile.followWindow(windowId)
  }

  /** Which pages may open windows without a click (the user's « Toujours autoriser sur ce site »); set once by the browser. */
  setPopupPolicy(allowed: (url: string) => boolean): void {
    this.popupPolicy = allowed
  }

  /** Registers how a mini window is opened from an error page; set once by the shell. */
  setMiniWindowOpener(opener: (url: string) => void): void {
    this.miniOpener = opener
  }

  /** Register a handler for toggling block exceptions for a page. */
  setBlockExceptionHandler(pageId: string, handler: (url: string) => void): void {
    this.blockExceptionHandlers.set(pageId, handler)
  }

  /** Forgets the handler of a page that is closed (the table would otherwise keep one entry per page ever opened). */
  clearBlockExceptionHandler(pageId: string): void {
    this.blockExceptionHandlers.delete(pageId)
  }

  /** What an extension page opened (native ports, mostly) ends when its document does: it is reloaded, goes elsewhere, or its renderer dies. */
  protected watchFrameContext(wc: WebContents): void {
    if (this.watchedFrames.has(wc)) return
    this.watchedFrames.add(wc)
    const context = `frame:${wc.id}`
    const gone = (): void => this.contextGone({ context })
    wc.once('destroyed', gone)
    wc.on('render-process-gone', gone)
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) gone()
    })
  }

  protected contextGone(gone: { context?: string; extensionId?: string; profileId?: string }): void {
    // A page of an extension that ends takes its request listeners with it. (A worker is told to its own session: installShims.)
    if (gone.context?.startsWith('frame:')) for (const profile of this.profiles.values()) this.extensionNets.get(profile.session)?.contextGone(gone.context)
    for (const listener of this.contextGoneListeners) listener(gone)
  }

  onContextGone(listener: (gone: { context?: string; extensionId?: string; profileId?: string }) => void): void {
    this.contextGoneListeners.push(listener)
  }

  /** What the extension declares in the profile of this tab: the profile it acts in. */
  private manifestForTab(extensionId: string, tabNumber: number): { permissions?: unknown; host_permissions?: unknown; omnibox?: unknown } | undefined {
    const profileId = this.profileOfTab(tabNumber)
    return profileId === undefined ? undefined : this.manifests.get(`${profileId}:${extensionId}`)
  }

  mayCaptureTab(extensionId: string, tabNumber: number): boolean {
    const url = this.tabUrl(tabNumber)
    const manifest = this.manifestForTab(extensionId, tabNumber)
    return url !== undefined && manifest !== undefined && canCaptureTab({ extensionId, access: accessOf(manifest), grants: this.activeTabs }, { id: tabNumber, url })
  }

  mayReadTab(extensionId: string, tabNumber: number): boolean {
    const url = this.tabUrl(tabNumber)
    const manifest = this.manifestForTab(extensionId, tabNumber)
    return url !== undefined && manifest !== undefined && canReadTab({ extensionId, access: accessOf(manifest), grants: this.activeTabs }, { id: tabNumber, url })
  }

  writeClipboard(items: { text: string; html: string }): Promise<void> {
    const entries: Record<string, string> = {}
    if (items.text !== '') entries['text/plain'] = items.text
    if (items.html !== '') entries['text/html'] = items.html
    if (Object.keys(entries).length === 0) return Promise.resolve()
    const written = clipboard.write([new ClipboardItem(entries)])
    // A failed write is reported to whoever asked; the next paste does not wait on it for ever.
    this.clipboardWrites = this.clipboardWrites.then(() => written).catch(() => undefined)
    return written
  }

  clipboardSettled(): Promise<void> {
    return this.clipboardWrites
  }

  mayActOnTab(extensionId: string, tabNumber: number): boolean {
    const url = this.tabUrl(tabNumber)
    const manifest = this.manifestForTab(extensionId, tabNumber)
    return url !== undefined && manifest !== undefined && hasHostAccess(accessOf(manifest), url)
  }

  tabUrl(tabNumber: number): string | undefined {
    const wc = allWebContents.fromId(tabNumber)
    return wc && !wc.isDestroyed() && this.tabMeta.has(tabNumber) ? wc.getURL() : undefined
  }

  setShimHandler(handler: ShimHandler): void {
    this.shimHandler = handler
  }

  setActionMenuItems(provider: ((profileId: string, extensionId: string) => ActionMenuEntry[]) | null): void {
    this.actionMenu = provider
  }

  emitShimEvent(extensionId: string, api: string, event: string, args: unknown[], profileId?: string): void {
    // An event exists for the extension that declared the permission of its API, like the calls: not for the others. It is judged for each
    // profile the event reaches, on the version of the extension that profile loaded.
    const reaches = (target: string | undefined): boolean =>
      target !== undefined && (profileId === undefined || target === profileId) && shimEventAllowed(this.manifests.get(`${target}:${extensionId}`), api, event)
    const scope = `chrome-extension://${extensionId}/`
    for (const worker of this.extensionWorkers) {
      if (worker.isDestroyed() || worker.scope !== scope) continue
      if (reaches(this.workerProfile.get(worker))) worker.send(SHIM_EVENT_CHANNEL, api, event, args)
    }
    for (const frame of this.extensionFrames) {
      if (frame.isDestroyed() || !frame.getURL().startsWith(scope)) continue
      if (reaches(this.profileOfSession(frame.session))) frame.send(SHIM_EVENT_CHANNEL, api, event, args)
    }
  }

  /**
   * An event for the pages of an extension named by their context (`frame:<id>`, as their calls name them), beyond the panels `emitShimEvent`
   * reaches: a Manifest V2 background page, a popup, a page of options that listens to chrome.webRequest. Each page is checked again here: still
   * there, a page of this extension, in the session of this profile, and the extension holds the permission of the event.
   */
  protected emitToExtensionPages(extensionId: string, profileId: string, contexts: readonly string[], api: string, event: string, args: unknown[]): void {
    if (!shimEventAllowed(this.manifests.get(`${profileId}:${extensionId}`), api, event)) return
    const scope = `chrome-extension://${extensionId}/`
    for (const context of contexts) {
      if (!context.startsWith('frame:')) continue
      const page = allWebContents.fromId(Number(context.slice('frame:'.length)))
      // A panel was reached by `emitShimEvent` already.
      if (!page || page.isDestroyed() || this.extensionFrames.has(page) || !page.getURL().startsWith(scope) || this.profileOfSession(page.session) !== profileId) continue
      page.send(SHIM_EVENT_CHANNEL, api, event, args)
    }
  }

  /** Starts the worker of an extension where it is loaded and waits until it runs. A stopped worker has no listener left, so a click sent
   *  to it would be dropped without a trace (electron-chrome-extensions sends events only to registered listeners). */
  async wakeExtension(extensionId: string): Promise<void> {
    const scope = `chrome-extension://${extensionId}/`
    for (const profile of this.profiles.values()) {
      if (!profile.session.extensions?.getExtension(extensionId)) continue
      const running = () => Object.values(profile.session.serviceWorkers.getAllRunning()).some((w) => w.scope === scope)
      if (running()) continue
      try {
        await profile.session.serviceWorkers.startWorkerForScope(scope)
      } catch (error) {
        // It refuses while a start is already under way: the wait below takes that start. Logged, so that a worker that never starts is visible.
        console.warn(`[engine] the worker of ${extensionId} did not start at once:`, error)
      }
      const deadline = Date.now() + 10_000
      while (!running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async deliverToWorker(extensionId: string, profileId: string, api: string, event: string, args: unknown[]): Promise<void> {
    const profile = this.profiles.get(profileId)
    if (!profile) return
    const scope = `chrome-extension://${extensionId}/`
    const running = () => Object.values(profile.session.serviceWorkers.getAllRunning()).some((w) => w.scope === scope)
    if (!running()) {
      // A worker that was stopped for being idle is started for the event, as it is for an alarm.
      try {
        await profile.session.serviceWorkers.startWorkerForScope(scope)
      } catch {
        // It refuses while the worker is already starting (right after the extension was loaded): wait for that start to end.
        const deadline = Date.now() + 10_000
        while (!running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
        if (!running()) throw new Error(`The worker of ${extensionId} did not start`)
      }
    }
    for (const worker of this.extensionWorkers) {
      if (!worker.isDestroyed() && worker.scope === scope && this.workerProfile.get(worker) === profileId) worker.send(SHIM_EVENT_CHANNEL, api, event, args)
    }
  }

  relayNativeEvent(extensionId: string, profileId: string, name: string): void {
    if (!this.profiles.has(profileId) || !isRelayedEvent(name)) return
    this.relays.listen(profileId, extensionId, name)
  }

  protected registerRelay(view: WebContentsView, extensionId: string, name: string): void {
    if (!isRelayedEvent(name)) return
    view.webContents.executeJavaScript(relayScript(extensionId, name)).catch((error: unknown) => console.warn(`[engine] cannot relay ${name} of ${extensionId}:`, error))
  }

  /** What the extension's worker is told when it is loaded: installed, updated, or started with the browser. */
  protected announceLifecycle(profileId: string, extensionId: string, version: string): void {
    const ledger = this.extensionLedger()
    const events = lifecycleEvents(ledger.versionOf(profileId, extensionId), version)
    ledger.record(profileId, extensionId, version)
    for (const { event, ...rest } of events) {
      const args = 'details' in rest ? [rest.details] : []
      this.deliverToWorker(extensionId, profileId, 'runtime', event, args).catch((error: unknown) => console.warn(`[engine] cannot send ${event} to ${extensionId}:`, error))
    }
  }

  sendExtensionEvent(extensionId: string, profileId: string, name: string, args: unknown[]): void {
    // Pressing the shortcut of a command hands the tab to the extension, like a click on its icon.
    const tab = name === 'commands.onCommand' ? (args[1] as { id?: unknown } | undefined) : undefined
    if (typeof tab?.id === 'number') this.grantActiveTab(extensionId, tab.id)
    this.profiles.get(profileId)?.router.sendEvent(extensionId, name, ...args)
  }

  updateContextMenuItem(extensionId: string, profileId: string, menuItemId: unknown, properties: unknown): void {
    const profile = this.profiles.get(profileId)
    if (!profile) throw new Error(`No profile ${profileId}`)
    updateContextMenuItem(profile.extensions, extensionId, menuItemId, properties)
  }

  /** The user invoked the extension on this tab: until the tab leaves the origin it is on, the extension may read it and capture it (activeTab). */
  protected grantActiveTab(extensionId: string, tabNumber: number): void {
    const url = this.tabUrl(tabNumber)
    if (url !== undefined) this.activeTabs.grant(extensionId, tabNumber, url)
  }

  setTabFactsProvider(provider: ((tabNumber: number) => TabFacts) | null): void {
    this.tabFacts = provider
  }

  notifyTabChanged(tabNumber: number): void {
    // The extension library listens to this event to send chrome.tabs.onUpdated (it compares the tab with what it last told).
    for (const page of this.pages.values()) {
      const wc = page.liveContents()
      if (wc?.id === tabNumber) wc.emit('tab-updated')
    }
  }

  onTabClosed(listener: (tabNumber: number) => void): void {
    this.tabClosedListeners.push(listener)
  }

  profileOfTab(tabNumber: number): string | undefined {
    return this.tabMeta.get(tabNumber)?.profileId
  }

  windowOfTab(tabNumber: number): number | undefined {
    const win = this.tabMeta.get(tabNumber)?.win
    return win && !win.isDestroyed() ? win.id : undefined
  }

  protected profileOfSession(ses: Session): string | undefined {
    for (const [id, profile] of this.profiles) if (profile.session === ses) return id
    return undefined
  }

  tabNumberOf(pageId: string): number | undefined {
    const wc = this.pages.get(pageId)?.liveContents()
    return wc ? wc.id : undefined
  }

  pageIdOfTabNumber(tabNumber: number): string | undefined {
    for (const [id, page] of this.pages) if (page.liveContents()?.id === tabNumber) return id
    return undefined
  }

  /**
   * chrome.scripting on a tab the user lent to the extension with a click, which Chromium refuses for want of a host permission
   * (shared/active-tab-script.ts). Refused in Chromium's own words for any other tab: one that was not lent, one of another profile,
   * one that has since gone to another site, a page that is not of the web.
   */
  protected async scriptLentTab(profileId: string, extensionId: string, method: string, raw: unknown, viaTabsApi = false): Promise<unknown> {
    const injection = readInjection(raw, method === 'executeScript' ? 'script' : 'css')
    const manifest = this.loaded.has(`${profileId}:${extensionId}`) ? this.manifests.get(`${profileId}:${extensionId}`) : undefined
    // Asked again before each thing done in the page: the files are read first, and a script that runs can send the tab elsewhere, so the
    // page that was lent when the call came in may not be the one the next line would touch. Answers the origin that was lent. What this
    // process knows of the tab is only where it was when it last heard: the document that runs the script judges it again (guardedScript).
    const lentNow = (): string => {
      const url = this.profileOfTab(injection.tabId) === profileId ? this.tabUrl(injection.tabId) : undefined
      // chrome.tabs.insertCSS asks for no "scripting" permission, which an extension of Manifest V2 cannot have: the loan is all it needs.
      const held = manifest ? accessOf(manifest).permissions : undefined
      const origin = held ? lentOrigin(viaTabsApi ? new Set([...held, 'scripting']) : held, this.activeTabs, extensionId, injection.tabId, url) : null
      if (origin === null) throw new Error(NO_PAGE_ACCESS)
      return origin
    }
    lentNow()
    const wc = allWebContents.fromId(injection.tabId)
    if (!wc || wc.isDestroyed()) throw new Error(`No tab with id: ${injection.tabId}.`)
    const folder = this.known.get(`${profileId}:${extensionId}`)?.path
    const texts: string[] = []
    for (const file of injection.files ?? []) {
      const path = folder === undefined ? null : insideFolder(folder, file)
      if (path === null) throw new Error(`Could not load file: '${file}'.`)
      const info = await stat(path).catch(() => null)
      // The words of the extension platform for a file that is not there; one that is too long is not read either.
      if (!info?.isFile() || info.size > SCRIPT_MAX_CHARS) throw new Error(`Could not load file: '${file}'.`)
      texts.push(await readFile(path, 'utf8'))
    }
    if (method === 'executeScript') {
      const scripts = injection.func !== undefined ? [callOf(injection.func, injection.args)] : texts
      // A script of the extension's own world is given what a content script has of its extension (chrome.runtime, chrome.storage, the messages); the page's world has none, as on the extension platform.
      // A page that does not take it is told in the journal, and the script runs with the page alone, as it did before this existed.
      if (!injection.mainWorld) {
        // Asked again just before: the files were read since the loan was last looked at, and the page is not given a bridge for a tab that has left its site.
        lentNow()
        await this.lentTabs.ensure(injection.tabId, extensionId, profileId)
      }
      let result: unknown
      for (const code of scripts) result = await this.runInDocument(wc, extensionId, injection.mainWorld, lentNow(), code)
      return [{ frameId: 0, result: result ?? null }]
    }
    const sheets = injection.css !== undefined ? [injection.css] : texts
    for (const css of sheets) {
      const origin = lentNow()
      const held = `${extensionId}:${injection.tabId}:${injection.userOrigin ? 'u' : 'a'}:${css}`
      if (method === 'insertCSS') {
        if (this.lentStyles.has(held)) continue
        const key = await wc.insertCSS(css, { cssOrigin: injection.userOrigin ? 'user' : 'author' })
        // The sheet went to the document the tab had when the message got there, which this process cannot tell beforehand (nothing in the sheet can say whose
        // it is). The document is asked once it is in: a tab that is no longer on the origin that was lent has the sheet taken out, and the call is refused.
        try {
          await this.runInDocument(wc, extensionId, false, origin, 'true')
        } catch (error) {
          await wc.removeInsertedCSS(key).catch((removing: unknown) => console.warn(`[engine] cannot take a style sheet of ${extensionId} out of tab ${injection.tabId}:`, removing))
          throw error
        }
        setBounded(this.lentStyles, held, key, 256)
      } else {
        // Only what this call inserted in the document the tab shows is taken out: the keys of a document that is gone are forgotten (forgetLentStyles).
        const key = this.lentStyles.get(held)
        this.lentStyles.delete(held)
        if (key !== undefined) await wc.removeInsertedCSS(key)
      }
    }
    return undefined
  }

  /**
   * Runs a script of an extension in the page of a tab the user lent it, in the world of the page or in the extension's own, preceded by the check that the
   * document is of the origin that was lent (guardedScript). The check refuses by throwing, and the engine of the page reports a script that threw only as
   * "Script failed to execute" (measured: the message is not handed on): when a script fails, the document is asked where it is, and a document that is not of the
   * origin that was lent gives the refusal of the platform, in its words. Any other failure is the script's own and goes on unchanged.
   */
  private async runInDocument(wc: WebContents, extensionId: string, mainWorld: boolean, origin: string, code: string): Promise<unknown> {
    const run = (text: string): Promise<unknown> => (mainWorld ? wc.mainFrame.executeJavaScript(text) : wc.executeJavaScriptInIsolatedWorld(this.scriptWorlds.of(extensionId), [{ code: text }]))
    try {
      return await run(guardedScript(origin, code))
    } catch (error) {
      if (refusedByDocument(error) || (await this.documentIsElsewhere(run, origin, extensionId))) throw new Error(NO_PAGE_ACCESS)
      throw error
    }
  }

  /** Whether the document that just failed a script is of another origin than the one that was lent. When it cannot be asked, no: the failure of the script is then the answer, and the log says why it was not told apart. */
  private async documentIsElsewhere(run: (text: string) => Promise<unknown>, origin: string, extensionId: string): Promise<boolean> {
    try {
      return (await run('location.origin')) !== origin
    } catch (asking) {
      console.warn(`[engine] cannot ask the page of a tab lent to ${extensionId} where it is:`, asking)
      return false
    }
  }

  /** A new document in a tab: the style sheets an extension inserted in the one it replaces are gone with it, and the keys that would take them out mean nothing in this one. */
  protected forgetLentStyles(tabNumber: number): void {
    for (const held of [...this.lentStyles.keys()]) if (held.split(':')[1] === String(tabNumber)) this.lentStyles.delete(held)
  }

  /** A call of the shims about the request rules or the request listeners of an extension (src/preload/extension-shims.ts). */
  private netCall(profileId: string, extensionId: string, api: string, method: string, args: unknown[], context: string): unknown {
    const ses = this.profiles.get(profileId)?.session
    const net = ses ? this.extensionNets.get(ses) : undefined
    if (!net) throw new Error('The extension is not loaded in a profile.')
    switch (`${api}.${method}`) {
      case 'declarativeNetRequest.mirror':
        return net.mirror(extensionId, args[0])
      case 'declarativeNetRequest.getEnabledRulesets':
        return net.enabledRulesets(extensionId)
      case 'declarativeNetRequest.updateEnabledRulesets':
        return net.updateEnabledRulesets(extensionId, args[0])
      case 'declarativeNetRequest.updateStaticRules':
        return net.updateStaticRules(extensionId, args[0])
      case 'declarativeNetRequest.getDisabledRuleIds':
        return net.disabledRuleIds(extensionId, args[0])
      case 'declarativeNetRequest.getAvailableStaticRuleCount':
        return net.availableStaticRuleCount(extensionId)
      case 'webRequest.listen':
        return net.listen(extensionId, context, args[0], args[1], args[2], args[3] === true)
      case 'webRequest.answer':
        return net.answer(extensionId, context, args[0], args[1])
      default:
        throw new Error(`chrome.${api}.${method} is not provided.`)
    }
  }

  /**
   * `chrome.permissions`: what the extension holds beyond its manifest, and a request that is a question to the person (optional-grants.ts). `sender`
   * is the page that asked, whose window the sheet belongs to; a worker has none.
   */
  private permissionsCall(profileId: string, extensionId: string, method: string, args: unknown[], sender: WebContents | undefined): unknown {
    switch (method) {
      case 'request':
        return this.optionalGrants.request(profileId, extensionId, args[0], sender)
      case 'contains':
        return this.optionalGrants.contains(profileId, extensionId, args[0])
      case 'getAll':
        return this.optionalGrants.getAll(profileId, extensionId)
      case 'remove':
        return this.optionalGrants.remove(profileId, extensionId, args[0])
      default:
        throw new Error(`chrome.permissions.${method} is not provided.`)
    }
  }

  /** The id an extension claims must be the one of the context that sent the call. */
  protected async dispatchShim(senderExtensionId: string, profileId: string, claimedId: string, api: string, method: string, args: unknown[], context: string, sender?: WebContents): Promise<unknown> {
    if (senderExtensionId !== claimedId) throw new Error('Extension id mismatch')
    if (!this.shimHandler) throw new Error('chrome.* shims are not ready')
    // An API is only defined for an extension that declared its permission; the extension side of the shim does not decide that.
    if (!shimAllowed(this.manifests.get(`${profileId}:${claimedId}`), api, method)) throw new Error(`The extension has no permission to use chrome.${api}.${method}.`)
    // The request rules and the request listeners are the engine's own business: the hooks of the session apply them.
    if (api === 'declarativeNetRequest' || api === 'webRequest') return this.netCall(profileId, claimedId, api, method, args, context)
    // A script for a tab the user lent with a click (activeTab): the engine runs it, since it holds the page.
    if (api === 'scripting') return this.scriptLentTab(profileId, claimedId, method, args[0])
    if (api === 'lentTab') return this.lentTabCall(profileId, claimedId, method, args, context)
    if (api === 'permissions') return this.permissionsCall(profileId, claimedId, method, args, sender)
    if (!EXTENSION_LOG) return this.shimHandler({ extensionId: claimedId, profileId, api, method, args, context })
    const at = () => `+${((Date.now() - LOG_START) / 1000).toFixed(1)}s`
    console.log(`${at()} [ext-shim] ${api}.${method} ${JSON.stringify(args).slice(0, 160)}`)
    try {
      const result = await this.shimHandler({ extensionId: claimedId, profileId, api, method, args, context })
      console.log(`${at()} [ext-shim] ${api}.${method} -> ${JSON.stringify(result)?.slice(0, 200)}`)
      return result
    } catch (error) {
      console.log(`${at()} [ext-shim] ${api}.${method} !! ${(error as Error).message}`)
      throw error
    }
  }
}
