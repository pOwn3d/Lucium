// A layer of the class ElectronEngine (electron-engine.ts; the order of the layers: docs/architecture.md). The wiring of a profile: its session, the
// extension library and its router, and the user agent the pages present.

import { app, BrowserWindow, MenuItem, session, type Session, type WebContents } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { normalizeWindowUrl, windowBounds, windowUpdate } from '@shared/chrome-compat'
import { LIBRARY_NATIVE_MESSAGING, addActionMenuItems, extendActionMenu, installWorkerStart, keepActionIcon, keepActiveTabPerWindow, restrictLibraryApis, revokeHandlers, routerOf, windowFocusOf, wrapHandler, type LibraryGuard } from './ece-router'
import { workerStarter } from './worker-start'
import { ExtensionPreloads, LIBRARY_PRELOAD_IDS } from './extension-runtime'
import { keepPopupInWindow } from './action-popup'
import { chromeUserAgent } from '@shared/user-agent'
import { googleSignInIdentity } from '@shared/google-sign-in'
import { SignInAgents } from './google-sign-in-agent'
import { interfaceImageRequestHeaders, interfaceImageResponseHeaders } from '@shared/interface-images'
import { profilePartition } from './profile-partition'
import type { HardwareSession } from './web-hardware'
import { PROFILE_READY_MAX_MS, profileReady } from './profile-ready'
import { installInternalPages } from './internal-pages'
import { t } from '@shared/i18n'
import { normalizeTabCall, EXTENSION_LOG, LOG_START, type Profile, scalePopupAnchor } from './electron-engine-base'
import { ElectronEngineExtensions } from './electron-engine-extensions'

/** The user agent the application has for itself (Electron's, with the name of the application), read once before it is replaced for the pages. */
let APPLICATION_AGENT: string | undefined

export abstract class ElectronEngineProfile extends ElectronEngineExtensions {
  /**
   * The page and the window the library of `profileId` is given for the tab the shell opened for one of its extensions. The pages of every profile are
   * in one table: a page that is not a tab of this profile (another profile's, a private one, a panel) is refused, whatever id the shell answered,
   * since the library would otherwise list it among the tabs of this profile's extensions.
   */
  protected pageOfExtensionTab(id: string, profileId: string): [WebContents, BrowserWindow] {
    const page = this.pages.get(id)
    if (!page) throw new Error(`Extension tab ${id} has no page`)
    if (this.profileOfTab(page.webContents.id) !== profileId) throw new Error(`Extension tab ${id} is not a tab of the profile of the extension`)
    return [page.webContents, page.window]
  }

  /** What the rules of the library (restrictLibraryApis, ece-router.ts) ask the engine, for the library of the profile `profileId`. */
  private libraryRules(profileId: string): LibraryGuard {
    return {
      grants: this.activeTabs,
      tabUrl: (tabNumber) => (this.profileOfTab(tabNumber) === profileId ? this.tabUrl(tabNumber) : undefined),
      manifestOf: (extensionId) => (this.loaded.has(`${profileId}:${extensionId}`) ? this.manifests.get(`${profileId}:${extensionId}`) : undefined),
      extensionIds: () => [...this.loaded.entries()].filter(([key]) => key.startsWith(`${profileId}:`)).map(([, info]) => info.id),
      activated: (extensionId, tabNumber) => {
        const tab = tabNumber ?? this.lastActivated.get(profileId)
        if (tab !== undefined && this.profileOfTab(tab) === profileId) this.grantActiveTab(extensionId, tab)
      },
      // The interface has no session of its own, so it is in the default one; every extension page and worker is in a profile's.
      fromInterface: (sender) => (sender as { session?: unknown } | null | undefined)?.session === session.defaultSession,
      // `chrome://extensions` and the other pages of the browser an extension asks a tab for open here, in the page of Lucium that stands for them (shared/chrome-pages.ts).
      openChromePage: (_extensionId, address) => this.hooks?.openChromePage?.(address) ?? false,
      ownsWindow: (windowId) => this.windowOfProfile(profileId, windowId) !== undefined,
      // The style sheet of a tab lent with a click goes the way chrome.scripting.insertCSS does, which has the document confirm the origin (the library's own call asks nothing of it).
      lentStyle: (extensionId, tabNumber, css) => this.scriptLentTab(profileId, extensionId, 'insertCSS', { target: { tabId: tabNumber }, css }, true),
      // The Extensions page shows the line under the extension: without it the person only sees an extension that says it was refused.
      permissions: {
        request: (extensionId, request, sender) => this.optionalGrants.request(profileId, extensionId, request, sender),
        contains: (extensionId, request) => this.optionalGrants.contains(profileId, extensionId, request),
        getAll: (extensionId) => this.optionalGrants.getAll(profileId, extensionId),
        remove: (extensionId, request) => this.optionalGrants.remove(profileId, extensionId, request)
      },
      ...(EXTENSION_LOG ? { trace: (message: string) => console.log(`+${((Date.now() - LOG_START) / 1000).toFixed(1)}s [ext-api] ${message}`) } : {}),
      // Where the library will hang the popup from: the window it was given the tab with (`tabMeta` holds the one `createPage` gave it). Nothing is refused for a sender whose window cannot be told.
      tabInWindowOfSender: (sender, tabNumber) => {
        const contents = sender as WebContents | null | undefined
        const win = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null
        return win === null || (this.profileOfTab(tabNumber) === profileId && this.windowOfTab(tabNumber) === win.id)
      },
      shownTabOfSender: (sender) => {
        const contents = sender as WebContents | null | undefined
        const win = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null
        return win && this.hooks ? this.hooks.activeTabOf?.(win.id, profileId) : undefined
      },
      activeTabOfSender: async (sender) => {
        const contents = sender as WebContents | null | undefined
        const win = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null
        if (!win || !this.hooks) return undefined
        const shown = this.hooks.activeTabOf?.(win.id, profileId)
        if (shown !== undefined) return shown
        // A window with no tab of this profile has none to give: one is opened in it (an extension expects every window to have a tab), so that the extension acts here.
        try {
          return this.tabNumberOf(await this.hooks.createTab(undefined, true, win.id, profileId))
        } catch (error) {
          console.warn('[extensions] cannot open a tab in the window of the icon that was clicked:', error instanceof Error ? error.message : error)
          // The click opened nothing: the user is told, instead of an icon that does nothing.
          this.notice(t('engine.impossible-d-ouvrir-un-onglet-dans-cette-fenetre-pour'))
          return undefined
        }
      }
    }
  }

  protected ensureProfile(profileId: string): Profile {
    const existing = this.profiles.get(profileId)
    if (existing) return existing

    const ses = session.fromPartition(profilePartition(profileId, 'a profile session'))
    // The Extensions page in a tab: this session serves it (engine/internal-pages.ts); a private context and a container refuse it.
    installInternalPages(ses, 'serve')
    this.applyProxyTo(ses, profileId, `profile ${profileId}`)
    this.installPermissions(ses, undefined, profileId)
    this.hardware.attach(profileId, ses as unknown as HardwareSession)
    this.installDisplayMedia(ses)
    this.installDownloads(ses, profileId)
    // Before the hooks: they ask it what the extensions of the profile need of them, and it has them installed again when that changes.
    const net = this.extensionNetOf(ses, profileId)
    this.installRequestBlocker(ses)
    this.installResponsePolicy(ses, () => this.responsePolicy)
    this.syncPageGuard(ses, this.guard !== null)
    if (EXTENSION_LOG) this.logExtensionActivity(ses)
    this.watchWorkerConsole(ses)
    this.extensionTools.attach(profileId, ses)

    const extensions = new ElectronChromeExtensions({
      session: ses,
      createTab: async (details) => {
        // The tab belongs to the profile of the extension that asked: never to the space the user happens to be in.
        return this.pageOfExtensionTab(await this.requireHooks().createTab(details.url, details.active !== false, details.windowId, profileId), profileId)
      },
      selectTab: (wc) => {
        const id = this.pageIdOf(wc)
        if (id) this.requireHooks().selectTab(id)
      },
      removeTab: (wc) => {
        const id = this.pageIdOf(wc)
        if (id) this.requireHooks().removeTab(id)
      },
      // What the library cannot know about a tab: the groups extensions put tabs in, and whether it is pinned.
      assignTabDetails: (details, wc) => {
        const facts = this.tabFacts?.(wc.id)
        if (!facts) return
        details.groupId = facts.groupId
        details.pinned = facts.pinned
      },
      createWindow: async (details) => {
        const popup = details.type === 'popup' || details.type === 'panel'
        // Whole numbers within limits: a size that is not a number would make the window refuse it after the window was created.
        const bounds = windowBounds(details)
        const id = await this.requireHooks().createWindow({
          type: popup ? 'popup' : 'normal',
          focused: details.focused !== false,
          profileId,
          ...(normalizeWindowUrl(details.url) !== null ? { url: normalizeWindowUrl(details.url)! } : {}),
          ...(bounds?.width !== undefined ? { width: bounds.width } : {}),
          ...(bounds?.height !== undefined ? { height: bounds.height } : {}),
          ...(bounds?.x !== undefined ? { left: bounds.x } : {}),
          ...(bounds?.y !== undefined ? { top: bounds.y } : {})
        })
        const created = BrowserWindow.fromId(id)
        if (!created) throw new Error('The window was not created')
        return created
      },
      removeWindow: (closing) => this.requireHooks().removeWindow(closing.id)
    })
    // The scripts the library just registered, and ours, wait until an extension is about to be loaded into this session.
    const runtime = new ExtensionPreloads(ses, { before: () => this.installShims(ses, profileId), after: () => this.installPatches(ses) }, `the session of profile ${profileId}`)
    const notHeld = runtime.holdLibrary(LIBRARY_PRELOAD_IDS)
    if (notHeld.length > 0) console.warn(`[extensions] electron-chrome-extensions no longer registers ${notHeld.join(', ')} the way src/main/engine/extension-runtime.ts expects: they stay in the session of profile ${profileId} from the start`)
    extensions.on('browser-action-popup-created', (popup) => {
      this.popupCount++
      // The library places the popup from the button alone: a wide popup under a button at an edge of the window would leave the window.
      popup.on('moved', () => keepPopupInWindow(popup))
      scalePopupAnchor(popup)
      this.closePopupOnPageClick(popup)
    })
    const router = routerOf(extensions)
    // One tab on show per window: the library's cache says one for the whole profile (see keepActiveTabPerWindow).
    keepActiveTabPerWindow(extensions)
    // The events the library sends to a worker start it this way: one start at a time per worker, a start under way waited for, and a line that
    // names the extension when it fails (worker-start.ts). Before restrictLibraryApis wraps `sendEvent`, which is read to tell the patch is there.
    installWorkerStart(router, workerStarter(ses.serviceWorkers, { nameOf: (id) => ses.extensions.getExtension(id)?.name }))
    revokeHandlers(router, LIBRARY_NATIVE_MESSAGING)
    // `chrome://newtab` is how an agent opens a blank working tab; the library refuses every chrome: address.
    for (const name of ['tabs.create', 'tabs.update']) {
      wrapHandler(router, name, (original) => (event, ...args) => original(event, ...args.map((arg) => normalizeTabCall(arg))))
    }
    // Whoever asks, the library answers with the window's active tab; the API answers only a page that is itself a tab (a worker or a
    // side panel gets nothing, which is how an agent panel knows it is a panel).
    wrapHandler(router, 'tabs.getCurrent', (original) => (event, ...args) => {
      const sender = event.sender as { id?: number } | undefined
      return sender?.id !== undefined && this.tabMeta.has(sender.id) ? original(event, ...args) : undefined
    })
    // The library only handles the state of a window; having the focus, a position and a size are applied here, before it answers,
    // so that the details it returns are the new ones.
    wrapHandler(router, 'windows.update', (original) => (event, ...args) => {
      // Only a window that shows a tab of this profile: the Settings window, a private window, another profile's window are not its to move.
      const target = this.windowOfProfile(profileId, args[0])
      if (target) {
        const { focus, bounds } = windowUpdate(args[1])
        if (bounds) target.setBounds({ ...target.getBounds(), ...bounds })
        if (focus) {
          target.show()
          target.focus()
        }
      }
      return original(event, ...args)
    })
    // The library lists the commands of a manifest without their shortcut.
    wrapHandler(router, 'commands.getAll', (original) => (event, ...args) => {
      const listed = original(event, ...args) as Array<{ name: string; shortcut: string }>
      const known = this.loaded.get(`${profileId}:${event.extension?.id ?? ''}`)?.commands ?? []
      return listed.map((command) => ({ ...command, shortcut: known.find((c) => c.name === command.name)?.label ?? command.shortcut }))
    })
    // A drawn icon (setIcon with an image) is kept, and a call with nothing to draw no longer wipes the icon (see keepActionIcon).
    keepActionIcon(router)
    // After the wrappers above: these are the outermost, so that what the extension sees is what they let through.
    restrictLibraryApis(router, this.libraryRules(profileId))
    // Whoever loads or unloads an extension of this session (the engine, the Web Store library, a switch in Settings) ends up here.
    ses.extensions.on('extension-loaded', (_event, extension) => {
      // Every way of loading goes through `prepareExtensions` first; this only catches one that does not, a little late for a worker already running.
      if (!runtime.active) {
        console.warn(`[extensions] ${extension.name} was loaded in profile ${profileId} without the runtime being prepared: its scripts are put in now`)
        runtime.activate()
      }
      if (this.isDisabled(profileId, extension.id)) {
        // Switched off in this profile (a folder loaded for the first time): it does not stay.
        this.known.set(`${profileId}:${extension.id}`, { info: { ...this.placeholder(profileId, extension.id, extension.path), name: extension.name, version: extension.version }, path: extension.path, manifest: extension.manifest })
        ses.extensions.removeExtension(extension.id)
        this.extensionsChanged()
        return
      }
      this.registerLoaded(profileId, extension)
    })
    ses.extensions.on('extension-unloaded', (_event, extension) => {
      this.forgetLoaded(profileId, extension.id)
      // Its request rules and its request listeners leave the hooks of the session with it.
      net.remove(extension.id)
      // Its hidden relay page goes with it (see ExtensionRelays.close).
      this.relays.close(profileId, extension.id)
      this.contextGone({ extensionId: extension.id, profileId })
      this.extensionsChanged()
    })
    // Right-click on a toolbar icon: switch it off here, uninstall it (store only), or manage the extensions.
    extendActionMenu(extensions, (extensionId) => {
      const source = this.known.get(`${profileId}:${extensionId}`)?.info.source
      return [
        new MenuItem({ type: 'separator' }),
        new MenuItem({ label: t('engine.desactiver-dans-ce-profil'), click: () => this.menuAction('disable', profileId, extensionId) }),
        ...(source === 'store' ? [new MenuItem({ label: t('engine.desinstaller'), click: () => this.menuAction('uninstall', profileId, extensionId) })] : []),
        new MenuItem({ label: t('menu.gerer-les-extensions'), click: () => this.menuAction('manage', profileId, extensionId) })
      ]
    })
    // The entries Lucium adds to the menu of an icon are asked for each time the menu opens: the pins may have changed since.
    addActionMenuItems(extensions, (extensionId) => (this.actionMenu?.(profileId, extensionId) ?? []).map((entry) => new MenuItem({ label: entry.label, click: () => entry.click() })))
    const focus = windowFocusOf(extensions)
    const profile: Profile = { session: ses, extensions, router, runtime, ready: null, followWindow: (windowId) => focus.follow(windowId) }
    this.profiles.set(profileId, profile)
    this.webStore.addProfile(profileId, ses)

    // A profile created after startup must get the same extensions as the others: the folders loaded by hand, and those installed in it.
    const loads: Array<Promise<unknown>> = []
    for (const path of this.extensionPaths) loads.push(this.loadFirst(profileId, ses, path, this.extensionLedger().idOfPath(path)))
    const stored = this.webStore.stored(profileId).then(
      (found) => Promise.all(found.map((extension) => this.loadFirst(profileId, ses, extension.path, extension.id))),
      (error: unknown) => console.error(`[engine] cannot list the extensions installed in profile ${profileId}:`, error)
    )
    // Only a profile that inherits folders makes its first pages wait (the list of the installed ones is read from disk: waiting for it would slow
    // every first page). An extension loaded while a page is loading can cut that page's first request.
    if (loads.length > 0) {
      const ready = profileReady([...loads, stored], PROFILE_READY_MAX_MS, `profile ${profileId}`)
      profile.ready = ready
      void ready?.then(() => {
        if (profile.ready === ready) profile.ready = null
      })
    }
    return profile
  }

  /**
   * The sign-in pages of Google show the identity of Electron as it is (shared/google-sign-in.ts): the user agent the application had before `presentPagesAsChrome` made the pages
   * a Chrome, in the tabs that are on those pages; the session of a tab that goes there is told to the engine (`watchSignInPages`). Called after `presentPagesAsChrome`. Null when the pages
   * were not made a Chrome: there is nothing to change then.
   */
  protected presentSignInAsElectron(): SignInAgents | null {
    const identity = googleSignInIdentity(APPLICATION_AGENT, app.userAgentFallback)
    return identity === null ? null : new SignInAgents(identity, (ses) => this.watchSignInPages(ses as Session))
  }

  /**
   * The pages of every session present the standard user agent of Chromium's own major version (see shared/user-agent.ts), not Electron and
   * not Lucium: sign-in pages refuse or warn about what they take for an embedded browser. This is done with the application-wide
   * fallback and not with `Session.setUserAgent`: the window a page opens with `window.open` is made by Chromium, which reads the fallback
   * and neither the session nor the page. The default session is then pinned to the application's own identity, so that the pages of the
   * interface and what the application fetches for itself (filter lists, updates, suggestions) keep the name of the application and
   * Electron's token. Once, as the engine starts, before any page exists.
   */
  protected presentPagesAsChrome(): void {
    const agent = chromeUserAgent(process.versions.chrome, process.platform)
    if (!agent) {
      // The requests the application makes for itself carry the header of Global Privacy Control whatever name the pages go by.
      this.ownRequests.add(session.defaultSession)
      return console.warn(`[engine] unexpected Chromium version "${process.versions.chrome}": the pages keep Electron's user agent`)
    }
    APPLICATION_AGENT ??= app.userAgentFallback
    session.defaultSession.setUserAgent(APPLICATION_AGENT)
    app.userAgentFallback = agent
    // The interface draws the icon of a site from the copy the main process keeps of it (site-icons.ts), and its pages may load no picture of the
    // web. Should one ever leave this session all the same, the site must meet the same browser for it as for the page, and no cookie goes or comes with
    // it: nothing erases the cookies of this session, which belongs to no profile, so a host of pictures could keep an identifier across profiles and
    // launches (shared/interface-images.ts). Only pictures: what the application fetches for itself keeps its own name.
    // Everything the application asks for itself in this session (the feed of the versions, the filter lists, the translation catalogue, the Chrome Web
    // Store, the suggestions) carries the header of Global Privacy Control while the option is on, as the pages do: the two rules share the one listener
    // a session has (own-requests.ts).
    this.ownRequests.add(session.defaultSession, { types: ['image'], headers: (headers) => interfaceImageRequestHeaders(headers, agent, false) })
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'], types: ['image'] }, (details, callback) => {
      callback({ responseHeaders: interfaceImageResponseHeaders(details.responseHeaders) })
    })
  }
}
