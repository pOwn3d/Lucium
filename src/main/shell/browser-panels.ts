// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). Glance, the side panel of extensions and the web
// panels, and the windows of the group as extensions see them.

import { randomUUID } from 'node:crypto'
import { clipboard } from 'electron'
import type { PeekAction } from '@shared/ipc'
import { platformOf } from '@shared/platform'
import { isPeekOpenKey, peekCardRect } from '@shared/peek'
import { WEB_PANEL_REFUSALS, webPanelHeading, webPanelRefusal, webPanelTitle, webPanelsOff, type WebPanelRequest } from '@shared/web-panels'
import { tabName } from '@shared/model'
import { httpsFallbackNotice } from '@shared/privacy'
import { applyOptions, optionsReachDockedPanel, panelContextsOf, panelProfile, panelUrl, PRIVATE_PANEL_REFUSAL, resolvePanel, type PanelOptions } from '@shared/sidepanel'
import { activeTab, splitIsFull, tabOpenedSince } from '@shared/sidebar'
import { hostOf } from '@shared/url'
import { isPageOpenUrl } from '@shared/external-links'
import type { Bounds, Page, PageEvents } from '../engine/types'
import { autoplayModeFor } from '@shared/autoplay'
import { t } from '@shared/i18n'
import { CERTIFICATE_NOTICE_MS, clientCertificateNotice } from './certificates'
import { BrowserTranslate } from './browser-translate'

export abstract class BrowserPanels extends BrowserTranslate {
  // ---- Glance (link preview) ----

  /**
   * `fromTabId`: the tab the link was clicked in. The preview lives in that tab's context (its private context, its container, the profile of its
   * space), not in the one of the tab that has the focus: in a split view, a link of a private pane must not be loaded with the cookies of the
   * profile because the other pane is the selected one. Absent: the tab on screen (a command of the user).
   */
  openPeek(url: string, fromTabId?: string): void {
    // Checked before anything exists: the address may come from a page, and a refused load must not leave a page and a preview behind.
    if (!isPageOpenUrl(url)) {
      console.warn(`[peek] refused a preview of a non-web address: ${String(url).split(':')[0]}:`)
      return
    }
    const tab = (fromTabId === undefined ? undefined : this.store.get().tabs.find((t) => t.id === fromTabId)) ?? activeTab(this.store.get())
    const space = this.store.get().spaces.find((s) => s.id === (tab?.spaceId ?? this.store.get().activeSpaceId))
    // One preview at a time; replacing it must not run the "overlay closed" side effects twice.
    this.destroyPeek()
    const id = this.pageId(`peek-${++this.peekCounter}`)
    // The preview of a link of a private tab stays in the private context: it must not read or leave the cookies of the space's profile. One of a
    // container's tab stays in the container.
    const isolated = tab?.private === true && !this.isPrivate()
    const container = isolated ? '' : this.containerKeyOf(tab)
    // The pages of a preview join the history of its space's profile like a tab's: not those of a private tab or of a container (they leave no trace),
    // and a private window has no history to join (`NO_HISTORY`).
    const history = isolated || container !== '' ? null : this.history.of(space?.profileId ?? 'default', space?.id)
    const page = (isolated ? this.privateContext() : container !== '' ? this.containerContext(container) : this.engine).createPage(
      { id, profileId: space?.profileId ?? 'default', windowId: this.options.windowId, autoplay: autoplayModeFor(this.store.get().settings, url) },
      {
        update: (patch) => {
          if (!this.peek || this.peek.page !== page) return
          this.peek = {
            ...this.peek,
            url: patch.url ?? this.peek.url,
            title: patch.title ?? this.peek.title,
            canGoBack: patch.canGoBack ?? this.peek.canGoBack,
            canGoForward: patch.canGoForward ?? this.peek.canGoForward,
            loading: patch.loading ?? this.peek.loading
          }
          // '' is "no icon to show" (the one the page declares is refused): the icon of the page before goes.
          if (patch.faviconUrl) this.peek.faviconUrl = patch.faviconUrl
          else if (patch.faviconUrl === '') delete this.peek.faviconUrl
          // The same rules as a tab: a load that came to no page (a frame, a download, one of our error pages) is no visit, and the title the page ended with is kept.
          if (patch.loading === false && patch.visit !== false && !page.showsError()) history?.record(this.peek.url, this.peek.title)
          else if (patch.title !== undefined && patch.loading !== false && !page.showsError()) history?.retitle(this.peek.url, this.peek.title)
          this.publish()
        },
        // Whatever the previewed page opens becomes a real tab (a private one for the preview of a private page).
        openWindow: (target) => {
          this.closeOverlay()
          this.dispatch({ type: 'tab/open', url: target, ...(isolated ? { private: true } : container !== '' ? { container } : {}), ...this.treeParent(activeTab(this.store.get())?.id) })
        },
        focused: () => {},
        // A preview hides ads and banners like a tab does: the lists are the user's, not a tab's.
        domReady: () => {
          this.blockerCss.fresh(id)
          this.blockerCss.apply(id, page, () => (this.peek?.page === page ? this.peek.url : undefined), () => this.peek?.page === page)
        },
        found: () => {},
        searchSelection: () => {},
        escape: () => this.closeOverlay(),
        // ⌘↩ in the previewed page does what the header's "Ouvrir dans un onglet" says: the key is the page's, until the preview has it.
        shortcut: (input) => {
          if (this.peek?.page !== page || !isPeekOpenKey(input, platformOf(process.platform))) return false
          this.peekAction('open-in-tab')
          return true
        },
        devToolsFailed: (message, retry) => this.devToolsNotice(message, retry),
        closed: () => {
          if (this.peek?.page === page) this.closeOverlay()
        }
      } satisfies PageEvents
    )
    this.peek = { page, url, title: hostOf(url) || url, loading: true, ...(isolated ? { private: true } : container !== '' ? { container } : {}) }
    try {
      page.loadURL(url)
    } catch (error) {
      // The engine refused the address: the preview is undone, so that nothing is left half open.
      console.error('[peek] the preview could not load its page:', (error as Error).message)
      this.destroyPeek()
      return
    }
    this.openOverlay({ panel: 'peek', rect: this.toCss(this.peekRect()), stage: this.toCss(this.stageRect()) })
  }

  peekAction(action: PeekAction): void {
    const peek = this.peek
    if (!peek) return
    if (action === 'back') return peek.page.goBack()
    if (action === 'forward') return peek.page.goForward()
    if (action === 'reload') return peek.page.reload()
    if (action === 'stop') return peek.page.stop()
    // « Copier l'adresse »: without the tracking parameters when the setting asks for it, as from the toolbar or a menu. The preview stays open.
    if (action === 'copy-address') {
      return void clipboard.writeText(this.copyable(peek.url)).catch((error: unknown) => {
        // The button has shown its tick by now: the user is told the address is not on the clipboard.
        console.error('[peek] cannot copy the address of the preview:', error)
        this.showToast(t('browser.l-adresse-n-a-pas-pu-etre-copiee'))
      })
    }
    const url = peek.url
    // A split view pairs the tab that was open with the one just made.
    const beside = action === 'open-in-split' ? activeTab(this.store.get()) : undefined
    // A split view that already has its four panes takes no more: the page is still opened, in a tab, and the user is told why it is not beside the others.
    const splitRefused = beside !== undefined && splitIsFull(this.store.get())
    const isolated = peek.private === true
    const container = peek.container
    this.closeOverlay()
    if (action === 'close') return
    const before = this.store.get()
    this.dispatch({ type: 'tab/open', url, ...(isolated ? { private: true } : container !== undefined ? { container } : {}), ...this.treeParent(beside?.id ?? activeTab(this.store.get())?.id) })
    // Only the tab this just made joins the split view: when the opening was refused (private tabs switched off meanwhile, a container that is
    // gone, an address too long to keep), the last tab of the state is one that was already there.
    const opened = tabOpenedSince(before, this.store.get())
    if (beside && opened) this.dispatch({ type: 'split/create', tabId: beside.id, withTabId: opened.id })
    if (splitRefused) this.showToast(t('peek.vue-scindee-pleine-la-page-est-ouverte-dans-un-onglet'))
  }

  protected destroyPeek(): void {
    const peek = this.peek
    if (!peek) return
    this.peek = null
    this.blockerCss.forget(peek.page.id)
    peek.page.destroy()
    this.leader.releasePrivateContext()
    this.publish()
  }

  /** The Glance card: 88 % of the page card wide, header included. */
  protected peekRect(): Bounds {
    const k = this.k()
    // Worked out in the CSS pixels of the interface (its insets are measured there), then put in points.
    return k === 1 ? peekCardRect(this.stageRect()) : this.fromCss(peekCardRect(this.toCss(this.stageRect())))
  }

  // ---- extension side panel (chrome.sidePanel) ----

  /** What an extension set for its panel (`chrome.sidePanel.setOptions`) is kept once for the windows of the group: the panel may open in any of them. */
  setSidePanelOptions(extensionId: string, tabKey: string | undefined, patch: PanelOptions): void {
    const configs = this.leader.panelConfigs
    configs.set(extensionId, applyOptions(configs.get(extensionId), tabKey, patch))
    for (const window of this.group) window.reconcileSidePanel({ extensionId, tabKey })
  }

  resolveSidePanel(extensionId: string, tabKey: string | undefined): { enabled: boolean; path: string | undefined } {
    const manifestPath = this.engine.listExtensions().find((e) => e.id === extensionId)?.sidePanelPath
    return resolvePanel(this.leader.panelConfigs.get(extensionId), tabKey, manifestPath)
  }

  /**
   * The profile a panel opened for this tab belongs to (the tab on screen in this window when none is named): the profile of the tab's space.
   * Null when no panel may open for it: a private tab, a private window (shared/sidepanel.ts `panelProfile`).
   */
  profileForPanel(tabKey: string | undefined): string | null {
    const state = this.store.get()
    return panelProfile(state, tabKey ? state.tabs.find((t) => t.id === tabKey) : activeTab(state), this.isPrivate())
  }

  /** Docks the extension's panel on the right of the window. Throws when it has no panel to show, and over a private tab. */
  openSidePanel(extensionId: string, tabKey: string | undefined): void {
    const tab = tabKey ? this.store.get().tabs.find((t) => t.id === tabKey) : activeTab(this.store.get())
    // Whoever asks (the extension, a click on its icon, a menu): nothing of an extension is docked beside a private tab.
    // The panel is docked at once, beside the tab on screen: that one counts as much as the tab the panel is asked for.
    const profileId = this.profileForPanel(tab?.id)
    if (profileId === null || this.profileForPanel(undefined) === null) throw new Error(PRIVATE_PANEL_REFUSAL)
    const { enabled, path } = this.resolveSidePanel(extensionId, tab?.id)
    const url = path ? panelUrl(extensionId, path) : null
    if (!enabled || !path || !url) throw new Error('This extension has no side panel to open for this tab.')
    if (this.sidePanel?.extensionId === extensionId && this.sidePanel.path === path) return
    // The dock holds one panel: a web panel gives way to the extension's.
    this.destroyWebPanel()
    this.destroySidePanel()
    const noop = () => {}
    const page = this.engine.createPage(
      { id: this.pageId('side-panel'), profileId, extensionPanel: true, windowId: this.options.windowId },
      {
        update: noop,
        openWindow: (target) => this.dispatch({ type: 'tab/open', url: target }),
        focused: noop,
        domReady: noop,
        found: noop,
        searchSelection: noop,
        devToolsFailed: (message, retry) => this.devToolsNotice(message, retry),
        // A panel closes itself with window.close() (an agent panel does when its shortcut is pressed again).
        closed: () => {
          if (this.sidePanel?.page === page) this.closeSidePanel()
        }
      }
    )
    const name = this.engine.listExtensions().find((e) => e.id === extensionId)?.name ?? extensionId
    this.sidePanel = { extensionId, name, path, page, profileId }
    page.loadURL(url)
    this.engine.emitShimEvent(extensionId, 'sidePanel', 'onOpened', [{ path, ...(tab ? { tabId: this.engine.tabNumberOf(tab.id) } : {}) }])
    this.layout()
    this.publish()
  }

  closeSidePanel(): void {
    // The ✕ of the dock's header closes whichever panel is docked.
    if (this.webPanel) return this.closeWebPanel()
    const open = this.sidePanel
    if (!open) return
    this.destroySidePanel()
    this.engine.emitShimEvent(open.extensionId, 'sidePanel', 'onClosed', [{ path: open.path }])
    this.layout()
    this.publish()
  }

  protected destroySidePanel(): void {
    const open = this.sidePanel
    this.sidePanel = null
    open?.page.destroy()
  }

  /**
   * The panel follows per-tab options: it closes or changes page when the user moves to a tab that asks for it. `set`: the options a call of
   * `chrome.sidePanel.setOptions` just set, followed only when they can change the docked panel (see `optionsReachDockedPanel`).
   */
  protected reconcileSidePanel(set?: { extensionId: string; tabKey: string | undefined }): void {
    const open = this.sidePanel
    if (!open) return
    const tab = activeTab(this.store.get())
    if (set && !optionsReachDockedPanel(set, open.extensionId, tab?.id)) return
    const { enabled, path } = this.resolveSidePanel(open.extensionId, tab?.id)
    if (!enabled || !path) this.closeSidePanel()
    // Over a private tab the panel docked stays the page it was: no other one is opened for that tab.
    else if (path !== open.path && this.profileForPanel(tab?.id) !== null) this.openSidePanel(open.extensionId, tab?.id)
  }

  // ---- web panels (Volets web): a site of the space's list, docked beside the page like an extension's side panel ----

  /** The width of the panel docked beside the page (an extension's or a web one), null when there is none. */
  protected dockWidth(): number | null {
    return this.sidePanel || this.webPanel ? this.store.get().settings.sidePanelWidth : null
  }

  /** Opens the site of this id from the list of the space on screen beside the page; the open one, chosen again, is put away. */
  openWebPanel(panelId: string): void {
    const state = this.store.get()
    if (this.isPrivate()) return void this.showToast(t('browser.les-volets-web-ne-sont-pas-disponibles-dans-une'))
    if (!state.settings.webPanels) return void this.showToast(webPanelsOff())
    const space = state.spaces.find((s) => s.id === state.activeSpaceId)
    const panel = space?.webPanels?.find((p) => p.id === panelId)
    if (!space || !panel || this.isTabLocked({ spaceId: space.id })) return
    if (this.webPanel?.spaceId === space.id && this.webPanel.panelId === panel.id) return this.closeWebPanel()
    // One panel at a time in the dock.
    this.destroyWebPanel()
    if (this.sidePanel) this.closeSidePanel()
    const noop = () => {}
    // The same hooks as a tab's page: its session is the space's profile (cookies, blocker, permissions, certificates), and the engine gives it
    // the error pages, HTTPS first and the navigation checks of any page. A link that wants a new window opens a tab of the space.
    const page = this.engine.createPage(
      { id: this.pageId(`webpanel-${++this.webPanelCounter}`), profileId: space.profileId, windowId: this.options.windowId },
      {
        // The address the panel is at: the name over it says so when it is no longer the site it was opened for.
        update: (patch) => {
          const open = this.webPanel
          if (patch.url === undefined || open?.page !== page || open.shownUrl === patch.url) return
          open.shownUrl = patch.url
          this.publish()
        },
        openWindow: (target) => this.dispatch({ type: 'tab/open', url: target, spaceId: space.id }),
        focused: noop,
        domReady: noop,
        found: noop,
        searchSelection: noop,
        httpsFallback: (host) => this.showToast(httpsFallbackNotice(host)),
        externalLinkFailed: (scheme) => this.showToast(t('browser.aucune-application-n-a-pu-ouvrir-ce-lien-scheme', { scheme })),
        clientCertificateRefused: (site) => this.showToast(clientCertificateNotice(site), undefined, CERTIFICATE_NOTICE_MS),
        devToolsFailed: (message, retry) => this.devToolsNotice(message, retry),
        closed: () => {
          if (this.webPanel?.page === page) this.closeWebPanel()
        }
      } satisfies PageEvents
    )
    this.webPanel = { spaceId: space.id, profileId: space.profileId, panelId: panel.id, title: panel.title, url: panel.url, page }
    this.noteProfileUsed(space.profileId)
    try {
      page.loadURL(panel.url)
    } catch (error) {
      console.error('[web panel] the engine refused to load', panel.url.split('?')[0], error)
      this.destroyWebPanel()
      this.showToast(t('browser.le-volet-title-n-a-pas-pu-s-ouvrir', { title: panel.title }))
    }
    this.layout()
    this.publish()
  }

  closeWebPanel(): void {
    if (!this.webPanel) return
    this.destroyWebPanel()
    this.layout()
    this.publish()
  }

  protected destroyWebPanel(): void {
    const open = this.webPanel
    this.webPanel = null
    open?.page.destroy()
  }

  /**
   * The panel closes when what it was opened from is gone: the function switched off, another space on screen, the site taken out of the list, or
   * the space given another profile (the page was made with the session of the old one: left open, it would show that profile's accounts in a space
   * that is no longer its own).
   */
  protected reconcileWebPanel(): void {
    const open = this.webPanel
    if (!open) return
    const state = this.store.get()
    const space = state.spaces.find((s) => s.id === open.spaceId)
    const listed = space?.webPanels?.some((p) => p.id === open.panelId && p.url === open.url) === true
    if (!state.settings.webPanels || state.activeSpaceId !== open.spaceId || !listed || space?.profileId !== open.profileId) this.closeWebPanel()
  }

  /** What the interface is told of the open panel (the name over it, see `webPanelHeading`). */
  protected webPanelOfSnapshot(): { webPanel?: { id: string; title: string; url: string } } {
    const open = this.webPanel
    return open ? { webPanel: { id: open.panelId, title: webPanelHeading(open.title, open.url, open.shownUrl), url: open.url } } : {}
  }

  /** Adds the page on screen to the web panels of the space on screen. A page that cannot be one says why in a notice. */
  addWebPanelFromPage(): void {
    const state = this.store.get()
    if (this.isPrivate()) return void this.showToast(t('browser.les-volets-web-ne-sont-pas-disponibles-dans-une'))
    if (!state.settings.webPanels) return void this.showToast(webPanelsOff())
    const tab = activeTab(state)
    const space = state.spaces.find((s) => s.id === state.activeSpaceId)
    // The page of a locked space is not on screen: it is neither added nor named in the notice.
    if (!tab || !space || this.isTabLocked(tab)) return void this.showToast(t('browser.aucune-page-a-ajouter-aux-volets'))
    // The panels of a space are saved with it: the page of a private tab does not become one.
    if (tab.private === true) return void this.showToast(t('browser.la-page-d-un-onglet-prive-ne-devient-pas-un-volet'))
    const refusal = webPanelRefusal(space.webPanels, tab.url)
    if (refusal) return void this.showToast(WEB_PANEL_REFUSALS[refusal])
    const title = webPanelTitle(tabName(tab), tab.url)
    this.dispatch({ type: 'space/panel-add', id: space.id, panelId: randomUUID(), url: tab.url, title })
    this.showToast(t('browser.title-est-un-volet-de-l-espace-name', { title, name: space.name }))
  }

  /** What the interface asks about web panels (the command bar). */
  webPanelRequest(request: WebPanelRequest): void {
    if (request.op === 'open') this.openWebPanel(request.panelId)
    else if (request.op === 'close') this.closeWebPanel()
    else this.addWebPanelFromPage()
  }

  // ---- hooks for extension shims ----

  /** The live page of a tab, in whichever window shows it. */
  pageFor(pageId: string): Page | undefined {
    for (const browser of this.group) {
      const page = browser.pages.get(pageId)
      if (page) return page
    }
    return undefined
  }

  /** Every window of this browser's group (the main one and the others over the same tabs). */
  windows(): this[] {
    return [...this.group]
  }

  /** The window with this Electron id, among the windows that show the same tabs. */
  browserOfWindow(windowId: number): this | undefined {
    return [...this.group].find((b) => b.win.id === windowId)
  }

  /** The id of this window as extensions know it. */
  windowId(): number {
    return this.win.id
  }

  /** The panel of an extension when it is open in a window of the group, for its profile: what chrome.runtime.getContexts reports as a side panel. */
  sidePanelContexts(extensionId: string, profileId: string): Array<{ documentUrl: string; windowId: number }> {
    return panelContextsOf(
      [...this.group].flatMap((b) => (b.sidePanel ? [{ extensionId: b.sidePanel.extensionId, path: b.sidePanel.path, profileId: b.sidePanel.profileId, windowId: b.win.id }] : [])),
      extensionId,
      profileId
    )
  }

  /**
   * chrome.commands: the user pressed the shortcut of an extension's command. The extension gets chrome.commands.onCommand with the
   * active tab, in the profile of that tab's space.
   */
  runExtensionCommand(extensionId: string, command: string): void {
    const state = this.store.get()
    const tab = activeTab(state)
    const space = state.spaces.find((s) => s.id === (tab?.spaceId ?? state.activeSpaceId))
    const tabNumber = tab ? this.engine.tabNumberOf(tab.id) : undefined
    const info = tab && tabNumber !== undefined ? { id: tabNumber, windowId: this.win.id, index: -1, active: true, pinned: tab.pinned, highlighted: true, incognito: false, url: tab.url, title: tab.title } : undefined
    this.engine.sendExtensionEvent(extensionId, space?.profileId ?? 'default', 'commands.onCommand', info ? [command, info] : [command])
  }

  /** Frees the web view of a tab ("discard"): it stays in the sidebar and reloads when selected. A page on screen is left alone. */
  sleepPage(pageId: string): void {
    void this.sleepNow(pageId)
  }

  listTabTargets(): Array<{ tabNumber: number; title: string; url: string }> {
    return this.store.get().tabs.flatMap((t) => {
      const tabNumber = this.pageFor(t.id) ? this.engine.tabNumberOf(t.id) : undefined
      return tabNumber === undefined ? [] : [{ tabNumber, title: t.title, url: t.url }]
    })
  }
}
