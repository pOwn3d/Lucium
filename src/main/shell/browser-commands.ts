// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The commands of the page and of the tab:
// navigation, notices (toasts), reload, print, zoom, reader, developer tools, copies, the extensions of the toolbar, the sidebar of the window, themes. The lists of the task manager (browser-resources.ts), then summaries and translation (browser-translate.ts), stand on it.


import type { LittleOrigin } from '@shared/little'
import { fakeFillPlan, generateIdentity } from '@shared/fake-fill'
import { clipboard } from 'electron'
import type { NavCommand } from '@shared/ipc'
import type { RuntimeState, TabItem } from '@shared/model'
import type { NamedWindow } from '@shared/window-names'
import { changeWindowSidebar, cleanWindowSidebar, NO_WINDOW_SIDEBAR, type WindowSidebar, type WindowSidebarChange } from '@shared/window-sidebar'
import { pagePaletteCss, parseCssColor, resolveAppearance } from '@shared/theme'
import { activeProfileId, profileOfSpace } from '@shared/profiles'
import { guestWording } from '@shared/guest-window'
import { chosenZoomOf, stepZoom, withSiteZoom, zoomSiteOf } from '@shared/site-zoom'
import { readerUnavailableNotice } from '@shared/reader'
import { foldersToReveal } from '@shared/folders'
import { isDeveloperUrl } from '@shared/developer-mode'
import { copyableUrl, formatCopiedUrl, type CopyUrlFormat } from '@shared/copy-url'
import { activeTab, backClosesLookup, backClosesTab, stepSpace, stepTab } from '@shared/sidebar'
import { foldedAncestors } from '@shared/tab-tree'
import { hostOf, isNavigableUrl, resolveInput } from '@shared/url'
import { extensionsPageOf } from '@shared/settings-target'
import { deliverOmnibox, omniboxTarget, type OmniboxRequest } from '@shared/omnibox'
import type { ActionMenuEntry, Page } from '../engine/types'
import { withPinned } from '@shared/extension-overflow'
import { runDevTools } from './devtools-command'
import { copySelection, exportPage, savePage, type MarkdownTarget } from './markdown-export'
import { LIVE_START_DELAY_MS } from '@shared/live-folders'
import type { PasswordWindow } from './password-service'
import { t } from '@shared/i18n'
import { devToolsTarget, type DevToolsRequest } from '@shared/devtools-request'
import { toastDurationMs } from '@shared/toast'
import { readableFollowsSystem } from '@shared/readable-mode'
import type { ToastMore } from './browser-base'
import { BrowserOverlay } from './browser-overlay'
import { windowSidebarCause } from './sidebar-trace'

export abstract class BrowserCommands extends BrowserOverlay {
  nav(command: NavCommand): void {
    // In a split view: the pane the user is in (see `followPaneFocus`), as for every command of the page below.
    this.followPaneFocus()
    const page = this.activePage()
    if (!page) return
    if (command === 'back') {
      // A tab opened from a link, still on its first page: Back closes it and returns to the tab it came from.
      const tab = activeTab(this.store.get())
      if (tab && this.backCloses(tab.id)) this.dispatch({ type: 'tab/back-to-origin', id: tab.id })
      else page.goBack()
    } else if (command === 'forward') page.goForward()
    // A site in Developer Mode reloads without the HTTP cache: what a developer wants after editing a file.
    else if (command === 'reload') this.isDeveloperPage() ? page.reloadIgnoringCache() : page.reload()
    else page.stop()
  }

  /** Whether Back would close this tab and return to the one it was opened from (rules: `backClosesTab`). */
  protected backCloses(tabId: string): boolean {
    return backClosesTab(this.store.get(), tabId, this.runtime.tabs[tabId]?.canGoBack)
  }

  /** The runtime as the interface should see it: the tabs that Back would close are flagged, so that the button and the menu entry stay enabled. */
  protected withBackCloses(runtime: RuntimeState): RuntimeState {
    const state = this.store.get()
    // Off, or no tab with an origin: nothing is computed.
    if (!state.settings.backClosesOpenedTab || !state.tabs.some((t) => t.openerId !== undefined)) return runtime
    // `backCloses` for every tab, with the tabs looked up once (backClosesLookup): this runs at each snapshot.
    const closesBack = backClosesLookup(state)
    const closing = state.tabs.filter((t) => runtime.tabs[t.id] !== undefined && closesBack(t.id, this.runtime.tabs[t.id]?.canGoBack)).map((t) => t.id)
    if (closing.length === 0) return runtime
    const tabs = { ...runtime.tabs }
    for (const id of closing) tabs[id] = { ...tabs[id]!, backCloses: true }
    const shown = activeTab(state)
    return { ...runtime, tabs, ...(shown && closing.includes(shown.id) ? { backCloses: true } : {}) }
  }

  /** Whether the selected tab is on a site in Developer Mode (⌃D). */
  isDeveloperPage(): boolean {
    const state = this.store.get()
    return isDeveloperUrl(activeTab(state)?.url, state.settings.developerHosts)
  }

  /** Runs a script in the selected tab's page (the menu's page commands: transformations, jump to selection…). */
  evaluateInPage(js: string): Promise<unknown> {
    return this.activePage()?.evaluate(js) ?? Promise.resolve(undefined)
  }

  /** This window, for the password manager (shell/password-service.ts): its private state, the tab on screen, a notice, and its panel. */
  passwordWindow(): PasswordWindow {
    return (this.passwordView ??= {
      isPrivate: () => this.isPrivate(),
      target: () => {
        const tab = activeTab(this.store.get())
        const page = this.activePage()
        // A tab of a locked space has no page, and nothing that could be filled.
        if (!tab || !page || this.isTabLocked(tab)) return null
        return { url: tab.url, privateTab: tab.private === true, untrustedCertificate: this.runtime.tabs[tab.id]?.untrustedCertificate === true, fill: (plan) => page.fillLogin(plan) }
      },
      toast: (message, action, durationMs) => {
        this.showToast(message, action, durationMs)
        return this.toastCounter
      },
      dismissToast: (id) => this.dismissToastById(id),
      openPanel: () => this.openOverlay({ panel: 'passwords' })
    })
  }

  // ---- toasts: short notices with an optional action ----

  /**
   * Shows a notice at the foot of the sidebar; `action` runs when the user clicks its button. It stays 5 s, 8 s at least when it offers an action (shared/toast.ts), and
   * waits while the pointer or the focus is in it (`holdToast`).
   */
  showToast(message: string, action?: { label: string; run: () => void; second?: { label: string; run: () => void } }, durationMs?: number, more: ToastMore = {}): void {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    const stays = toastDurationMs(action !== undefined, durationMs)
    this.toast = {
      id: ++this.toastCounter,
      message: this.guestWords(message),
      durationMs: stays,
      ...(action ? { action: action.label, run: action.run } : {}),
      ...(action?.second ? { secondAction: action.second.label, runSecond: action.second.run } : {}),
      ...(more.detail !== undefined ? { detail: this.guestWords(more.detail) } : {}),
      ...(more.progress ? { progress: { ...more.progress } } : {})
    }
    this.noticeLog.record(this.toast.id, Date.now(), this.toast.message, this.toast.detail)
    this.toastClock.start(stays, Date.now())
    this.toastTimer = setTimeout(() => this.dismissToast(), stays)
    this.publish()
  }

  /**
   * New words for the notice with this id, while it is still the one showing (the progress of a long job): its buttons and its time are kept, and it
   * does not come in again. `more` changes its second line and its bar too, and `second` gives it a second button (or new words for it). False when
   * it was replaced or closed meanwhile: the person closed it, or another notice took its place.
   */
  reviseToast(id: number, message: string, more: ToastMore & { second?: { label: string; run: () => void } } = {}): boolean {
    if (this.toast?.id !== id) return false
    const next = {
      ...this.toast,
      message: this.guestWords(message),
      ...(more.detail !== undefined ? { detail: this.guestWords(more.detail) } : {}),
      ...(more.progress ? { progress: { ...more.progress } } : {}),
      ...(more.second ? { secondAction: more.second.label, runSecond: more.second.run } : {})
    }
    const same = next.message === this.toast.message && next.detail === this.toast.detail && next.secondAction === this.toast.secondAction && next.progress?.done === this.toast.progress?.done && next.progress?.total === this.toast.progress?.total
    this.toast = next
    if (!same) {
      this.noticeLog.revise(id, next.message, next.detail)
      this.publish()
    }
    return true
  }

  /** The words of a notice, said for a guest window when this is one (shared/guest-window.ts). */
  private guestWords(words: string): string {
    return this.options.guest === true ? guestWording(words) : words
  }

  /** The pointer or the focus entered (held) or left the notice: its time stops, and goes on with what it had left. A stale call (the notice was replaced) does nothing. */
  holdToast(id: number, held: boolean): void {
    if (this.toast?.id !== id) return
    if (held) {
      if (!this.toastClock.hold(Date.now())) return
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = null
      return
    }
    const left = this.toastClock.release(Date.now())
    if (left !== null) this.toastTimer = setTimeout(() => this.dismissToast(), left)
  }

  /** Takes the notice with this id away, if it is still the one showing (the one that replaced it is left alone). */
  dismissToastById(id: number): void {
    if (this.toast?.id === id) this.dismissToast()
  }

  private dismissToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = null
    if (!this.toast) return
    this.toast = null
    this.publish()
  }

  /** The user clicked the toast's button (the second one when `second`). A stale click (the toast was replaced meanwhile) does nothing. */
  runToastAction(id: number, second = false): void {
    const toast = this.toast
    if (!toast || toast.id !== id) return
    this.dismissToast()
    ;(second ? toast.runSecond : toast.run)?.()
  }

  // ---- commands of the application menu ----

  /** Reloads the page without the HTTP cache. */
  hardReload(): void {
    this.followPaneFocus()
    this.activePage()?.reloadIgnoringCache()
  }

  /**
   * Empties the cache the page on screen is served from, then reloads it: the cache of its own context (the private context of a private tab,
   * the container of a tab in one), else of the profile of its space. Emptying the profile's for a private tab emptied a cache the page never read.
   */
  async clearCacheAndReload(): Promise<void> {
    this.followPaneFocus()
    const state = this.store.get()
    const tab = activeTab(state)
    const space = state.spaces.find((s) => s.id === (tab?.spaceId ?? state.activeSpaceId))
    await this.engineOf(tab).clearCache(space?.profileId ?? 'default')
    this.activePage()?.reloadIgnoringCache()
  }

  printPage(): void {
    this.followPaneFocus()
    this.activePage()?.print()
  }

  /** The suggested file name for "Save page as", or null when no page is open. Asked first: the pane it names is the one `savePage` saves after the box. */
  activePageTitle(): string | null {
    this.followPaneFocus()
    return activeTab(this.store.get())?.title ?? null
  }

  async savePage(path: string): Promise<void> {
    await this.activePage()?.savePage(path)
  }

  /**
   * ⌘+, ⌘− and ⌘0 (the menu and the mark of the toolbar too): the zoom of the site on screen; in a split view, of the pane the user is in (`followPaneFocus`).
   * It is kept for the site (every tab of it, now and at the next launch) and ⌘0 forgets it. A page that has no host (about:blank, a page its opener wrote, a
   * file) and a private tab keep theirs with the tab, for as long as its page lives, a reload included (shared/site-zoom.ts `zoomSiteOf`). A PDF has the zoom
   * of its own viewer, the reader the size of its text.
   */
  zoom(step: -1 | 0 | 1): void {
    this.followPaneFocus()
    const tab = activeTab(this.store.get())
    const page = this.activePage()
    if (!tab || !page) return
    void this.zoomPage(tab, page, step).catch((error: unknown) => console.error(`[zoom] cannot zoom ${tab.id}:`, error))
  }

  private async zoomPage(tab: TabItem, page: Page, step: -1 | 0 | 1): Promise<void> {
    if (await page.viewerZoom(step)) return
    // The tab may have moved on while the viewer was asked.
    if (this.pages.get(tab.id) !== page) return
    // The zoom a site keeps is saved with the settings: a private tab zooms for as long as its page lives, like a page that has no host.
    const host = zoomSiteOf(tab)
    const current = chosenZoomOf(tab, this.store.get().settings.siteZoom, this.volatileZoom.get(tab.id))
    const next = step === 0 ? 1 : stepZoom(current, step)
    if (!host) {
      this.volatileZoom.set(tab.id, next)
      return this.applyBoost(tab.id, false)
    }
    this.dispatch({ type: 'settings/update', patch: { siteZoom: withSiteZoom(this.store.get().settings.siteZoom, host, next) } })
    this.refreshZoom(host)
  }

  /** View › Reader mode: the article of the page on screen, on its own; Escape (or the same entry again) gives the page back. */
  async toggleReader(): Promise<void> {
    this.followPaneFocus()
    const page = this.activePage()
    if (!page) return
    if ((await page.toggleReader()) === 'unavailable') this.showToast(readerUnavailableNotice())
  }

  /** Add or remove a domain from the ad/tracker blocker exceptions. */
  toggleBlockException(url: string): void {
    const domain = hostOf(url)
    if (!domain) return
    // The exceptions are saved with the settings: a site a private tab is on is not written there, and the user is told why nothing changed.
    if (this.store.get().tabs.some((tab) => tab.private === true && hostOf(tab.url) === domain)) return this.showToast(t('browser.reglage-par-site-non-enregistre-pour-un-onglet-prive'))
    const settings = this.store.get().settings
    const blockExceptions = settings.blockExceptions || []
    const index = blockExceptions.indexOf(domain)
    const patch = index === -1 ? { blockExceptions: [...blockExceptions, domain] } : { blockExceptions: blockExceptions.filter((d) => d !== domain) }
    this.dispatch({ type: 'settings/update', patch })
  }

  /** Gives the zoom of a site to every page of it, in every window that shows these tabs. */
  private refreshZoom(host: string): void {
    for (const browser of this.group) {
      for (const tab of browser.store.get().tabs) {
        if (browser.pages.has(tab.id) && zoomSiteOf(tab) === host) browser.applyBoost(tab.id, false)
      }
    }
  }

  /** The tools of the page the user is looking at: the Glance when one covers the window, else the tab. What could not be done is said in a notice. */
  devTools(request: DevToolsRequest): void {
    this.followPaneFocus()
    const target = devToolsTarget({ peekShown: this.peek !== null && this.overlayRequest?.panel === 'peek', hasTab: this.activePage() !== undefined })
    const page = target === 'peek' ? this.peek?.page : target === 'tab' ? this.activePage() : undefined
    void runDevTools(page, request, (message) => this.showToast(message))
  }

  /** An address as it goes to the clipboard: without the known tracking parameters when the setting asks for it (see copyableUrl). */
  copyable(url: string): string {
    return copyableUrl(url, this.store.get().settings.stripCopiedLinks)
  }

  /** Puts the page's address (or a Markdown link, or a quote with a highlight link) on the clipboard. */
  async copyUrl(format: CopyUrlFormat): Promise<void> {
    this.followPaneFocus()
    const tab = activeTab(this.store.get())
    // The address of a tab the lock hides is not given away by the menu either.
    if (!tab || this.isTabLocked(tab)) return
    const selection = format === 'quote' ? String((await this.activePage()?.evaluate('String(getSelection())')) ?? '') : ''
    await clipboard.writeText(formatCopiedUrl(format, { url: this.copyable(tab.url), title: tab.title, selection }))
    this.showToast(format === 'markdown' ? t('browser.lien-markdown-copie') : format === 'quote' ? t('browser.citation-copiee') : t('browser.lien-copie'))
  }

  /** The command bar's calculator: the answer goes on the clipboard. The caller has checked it is a number (shared/calc.ts, `isCalcCopy`). */
  async copyCalcResult(text: string): Promise<void> {
    await clipboard.writeText(text)
    this.showToast(t('browser.resultat-copie-text', { text }))
  }

  /** File › Export the page as Markdown… (and the command bar): pick what to keep of the page, then copy it or save it (see shell/markdown-export.ts). */
  async exportMarkdown(): Promise<void> {
    this.followPaneFocus()
    const tab = activeTab(this.store.get())
    const page = this.activePage()
    if (tab && page) await exportPage(this.markdownTarget(tab, page))
  }

  /** File › Save the page as Markdown… (and the command bar): the whole main content, a .md and its images folder, no picker (see shell/markdown-export.ts). */
  async saveMarkdownPage(): Promise<void> {
    this.followPaneFocus()
    const tab = activeTab(this.store.get())
    const page = this.activePage()
    if (tab && page) await savePage(this.markdownTarget(tab, page))
  }

  /** "Copy as Markdown" in the page menu of a tab: the text it has selected, to the clipboard. */
  async copySelectionAsMarkdown(tabId: string): Promise<void> {
    const tab = this.store.get().tabs.find((t) => t.id === tabId)
    const page = this.pages.get(tabId)
    if (tab && page) await copySelection(this.markdownTarget(tab, page))
  }

  private markdownTarget(tab: TabItem, page: Page): MarkdownTarget {
    return { page, win: this.win, url: tab.url, title: tab.title, private: tab.private === true || this.isPrivate(), toast: (message, action) => this.showToast(message, action) }
  }

  /** Clicks an extension's icon in the sidebar toolbar, which opens its popup (the sidebar is shown first if it was hidden). */
  async activateExtension(extensionId: string): Promise<void> {
    // An extension that asked for its panel on a click of its icon (`sidePanel.setPanelBehavior`) gets its panel, as the click on the icon of the bar does
    // (App.tsx catches that click before it reaches the icon). From the « menu, from the Extensions menu or the command bar the icon may have no size at all
    // (an icon that does not fit is hidden), and what follows would only send `action.onClicked`, which such an extension does not handle: nothing would open.
    if (this.store.get().sidePanelBehavior[extensionId] === true) {
      try {
        this.openSidePanel(extensionId, undefined)
      } catch (error) {
        console.warn(`[side panel] ${extensionId} could not open from its icon:`, (error as Error).message)
      }
      return
    }
    if (!this.store.get().settings.sidebarVisible) {
      this.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // The worker first: a click on an idle worker is dropped (see wakeExtension in the engine).
    await this.engine.wakeExtension?.(extensionId)
    // An icon that is in the « menu has no size: its popup opens under that button instead, as the library would anchor it under the icon.
    const found = await this.win.webContents.executeJavaScript(
      `(() => {
        const list = document.querySelector('browser-action-list')
        const b = list?.shadowRoot?.getElementById(${JSON.stringify(extensionId)})
        if (!b) return false
        if (b.getBoundingClientRect().width > 0) { b.click(); return true }
        const anchor = (document.querySelector('.tb-overflow') ?? list).getBoundingClientRect()
        window.browserAction.activate(b.partition || '_self', { eventType: 'click', extensionId: b.id, tabId: b.tab, alignment: b.alignment, anchorRect: { x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height } })
        return true
      })()`
    )
    if (!found) console.warn(`[menu] the extension ${extensionId} has no toolbar button in this profile`)
  }

  /**
   * The command bar hands the text typed after an extension's keyword to that extension (shared/omnibox.ts): its worker is started if it
   * had stopped, told that input started, then given the text and where to open what it finds. The extension must run in the profile of the
   * space the user is in and have declared the keyword; a request for anything else is refused. When the worker does not take it, the user is told.
   */
  omniboxEnter(request: OmniboxRequest): void {
    const state = this.store.get()
    const profileId = activeProfileId(state)
    const extension = omniboxTarget(state.settings.omniboxKeywords, this.isPrivate(), profileId, this.engine.listExtensions(), request)
    if (typeof extension === 'string') return void console.warn(`[omnibox] the text was not sent: ${extension}`)
    this.closeOverlay()
    const name = extension.name
    void deliverOmnibox((event, args) => this.engine.deliverToWorker(extension.id, profileId, 'omnibox', event, args), request).catch((error: unknown) => {
      console.warn(`[omnibox] ${name} did not take the text:`, error instanceof Error ? error.message : String(error))
      this.showToast(t('browser.name-n-a-pas-pu-recevoir-le-texte-voir-le', { name }))
    })
  }

  /** Pins an extension's icon to the toolbar, or takes it out of the bar (it stays in the « menu). */
  setExtensionPinned(extensionId: string, pinned: boolean): void {
    this.dispatch({ type: 'settings/update', patch: { unpinnedExtensions: withPinned(this.store.get().settings.unpinnedExtensions, extensionId, pinned) } })
  }

  /** What Lucium adds to the right-click menu of an extension's icon. Nothing while the menu of the extension icons (`extensionOverflow`) is switched off: the icon's menu is then the standard one. */
  protected actionMenuEntries(extensionId: string): ActionMenuEntry[] {
    const { extensionOverflow, unpinnedExtensions } = this.store.get().settings
    if (!extensionOverflow) return []
    const pinned = !unpinnedExtensions.includes(extensionId)
    return [{ label: pinned ? t('browser.desepingler-de-la-barre-d-outils') : t('browser.epingler-a-la-barre-d-outils'), click: () => this.setExtensionPinned(extensionId, !pinned) }]
  }

  /** Selects the tab one step down or up the sidebar. */
  stepTab(direction: 1 | -1): void {
    const id = stepTab(this.store.get(), direction)
    if (id) this.dispatch({ type: 'tab/select', id })
  }

  stepSpace(direction: 1 | -1): void {
    const id = stepSpace(this.store.get(), direction)
    if (id) this.dispatch({ type: 'space/select', id })
  }

  /** Makes sure the selected tab can be seen in the sidebar: the sidebar is shown and its folder opened. */
  revealActiveTab(): void {
    const state = this.store.get()
    const tab = activeTab(state)
    if (!tab) return
    if (!state.settings.sidebarVisible) this.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
    for (const id of foldersToReveal(state.folders, tab.folderId)) this.dispatch({ type: 'folder/toggle', id })
    // A branch of the tab tree that is folded around the tab opens too.
    if (state.settings.tabTree) for (const id of foldedAncestors(state.tabs, tab.id)) this.dispatch({ type: 'tab/tree-collapse', id, collapsed: false })
  }

  /** Opens an address in a mini window (when the shell can). */
  /** The notice of developer tools that did not open: « Réessayer » when the failure can be tried again, and « Copier le message » with the text. */
  protected devToolsNotice(message: string, retry?: () => void): void {
    const copy = { label: t('errpage.copier-le-message'), run: () => clipboard.writeText(message) }
    this.showToast(message, retry ? { label: t('errpage.reessayer'), run: retry, second: copy } : copy)
  }

  /** The tab editor's address: resolved here as the command bar does (a web address or a search, nothing else), and loaded in the tab's page. */
  setTabAddress(tabId: string, input: string): void {
    // `chrome://extensions` is the address of the Extensions page, which the tab shows for it: the page it is typed over is not sent to a search for that text.
    const extensionsPage = extensionsPageOf(input)
    if (extensionsPage) return this.openExtensionsTab(extensionsPage)
    const tab = this.store.get().tabs.find((item) => item.id === tabId)
    const resolved = resolveInput(input, this.searchTemplateFor(tab ? profileOfSpace(this.store.get(), tab.spaceId) : activeProfileId(this.store.get())))
    if (!resolved) return this.showToast(t('browser.adresse-non-reconnue'))
    if (!isNavigableUrl(resolved.url)) return this.showToast(t('browser.adresse-invalide'))
    const page = this.pages.get(tabId)
    // A tab that has no page in this window (asleep, or shown by another window) cannot be sent anywhere from here: the editor has closed as
    // after a save, so the person is told that the address did not change.
    if (!page) return this.showToast(t('browser.adresse-non-changee-onglet-non-charge'))
    page.loadURL(resolved.url)
  }

  /** "Remplir avec de fausses données": one identity, written only into the empty fields of the form under the click. */
  protected async fillFakeForm(tabId: string, x: number, y: number): Promise<void> {
    const page = this.pages.get(tabId)
    if (!page?.readFormFields || !page.fillFormFields) return
    // The address is the tab's: an internal page or a file gets an empty plan (the marks are still removed below).
    const url = this.store.get().tabs.find((tab) => tab.id === tabId)?.url ?? ''
    const plan = fakeFillPlan(url, await page.readFormFields(x, y), generateIdentity())
    // Always called, even with an empty plan: the fill step also removes the marks the read step left on the page.
    await page.fillFormFields(plan)
  }

  openLittle(url: string): void {
    if (/^https?:\/\//i.test(url)) this.littleOpener?.(url, { from: this.windowBounds() })
  }

  /** The page history of the current tab on one side of the current page, nearest first: what the back or forward long press lists. */
  navigationHistory(direction: 'back' | 'forward'): Array<{ index: number; title: string; url: string }> {
    const { entries, index } = this.activePage()?.navigationEntries() ?? { entries: [], index: -1 }
    const indexes = direction === 'back' ? Array.from({ length: Math.max(0, index) }, (_, i) => index - 1 - i) : Array.from({ length: Math.max(0, entries.length - index - 1) }, (_, i) => index + 1 + i)
    return indexes.map((i) => ({ index: i, ...entries[i]! }))
  }

  goToHistoryIndex(index: number): void {
    this.activePage()?.goToIndex(index)
  }

  /** The window manager tells this window its own name and the names of the others (Fenêtre › Nommer la fenêtre…). */
  setWindowNames(source: { own(): string | undefined; others(): NamedWindow[] } | null): void {
    this.windowNames = source
  }

  /** The names changed: every surface of this window shows the new snapshot. */
  republish(): void {
    this.publishQueue.now()
  }

  /** The sidebar this window chose for itself (what windows.json keeps of it): empty when it follows the new windows. */
  windowSidebar(): WindowSidebar {
    return this.sidebarChoice
  }

  /** The choice a window had when it was last open (windows.json, read at launch), or none: kept to its known values. */
  setWindowSidebar(raw: unknown): void {
    this.applyWindowSidebar(cleanWindowSidebar(raw) ?? NO_WINDOW_SIDEBAR)
  }

  /**
   * « Barre de cette fenêtre » (the menus, ⌃⌘S, the button of the sidebar and the column's, the command bar): docks the sidebar of this window to a column of
   * icons or gives the full one back, or chooses its side. Docking a hidden sidebar shows its column. Only this window changes; the setting stays the side of
   * the new windows.
   */
  changeWindowSidebar(change: WindowSidebarChange): void {
    const { own, show } = changeWindowSidebar(this.sidebarChoice, change, this.store.get().settings)
    this.sidebarTrace.during(windowSidebarCause(change), () => {
      if (show) this.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
      this.applyWindowSidebar(own)
    })
  }

  /**
   * Lays the window out again for a new choice and tells its surfaces (the window manager, told by the publication, saves the windows). Before the window
   * started (a restored window is given its choice first) the choice is only kept: the first sync lays it out.
   */
  private applyWindowSidebar(own: WindowSidebar): void {
    if (own === this.sidebarChoice) return
    this.sidebarChoice = own
    // Not started yet, or closed meanwhile: nothing to lay out.
    if (this.unsubscribe === null || this.win.isDestroyed()) return
    this.layout()
    this.publishQueue.now()
  }

  /** The wait before the first look of the live folders: the application is just launching, so a while; a function switched on later starts at once. */
  protected liveStartDelayMs(): number {
    return this.liveStartDelay ?? (process.uptime() < 120 ? LIVE_START_DELAY_MS : 0)
  }

  /** Registers how to open a mini window (set once the shell has created the machinery). */
  setLittleOpener(opener: (url: string, origin?: LittleOrigin) => void): void {
    this.littleOpener = opener
  }

  /** The system appearance changed (or is now known): "automatic" themes follow it. */
  setSystemDark(dark: boolean): void {
    const line = this.toolbarLine()
    this.systemDark = dark
    this.refreshThemes()
    if (readableFollowsSystem(this.store.get().settings)) this.refreshDarkHere()
    // A page that declares no colour has a dark bar in a dark window and a light one (with its line) in a light window.
    if (this.toolbarLine() !== line) this.layout()
    this.publish()
  }

  /** Whether the appearance resolves to dark for a space, as the sidebar UI sees it. */
  isSystemDark(): boolean {
    return this.systemDark
  }

  /** The colour the active page declares (`<meta name="theme-color">`, else its background), as hex. */
  async siteColor(): Promise<string | null> {
    const color = await this.activePage()?.evaluate(
      `(() => document.querySelector('meta[name="theme-color"]')?.content || getComputedStyle(document.body).backgroundColor)()`
    )
    return parseCssColor(color)
  }

  /** The palette variables a page gets when "allow websites to get your theme data" is on. */
  private themeCssFor(tabId: string): string {
    const state = this.store.get()
    if (!state.settings.allowThemeToSites) return ''
    const tab = state.tabs.find((t) => t.id === tabId)
    const space = tab && state.spaces.find((sp) => sp.id === tab.spaceId)
    return space ? pagePaletteCss(space.theme, resolveAppearance(space.theme, this.systemDark)) : ''
  }

  protected applyThemeToPage(tabId: string, force = false): void {
    const page = this.pages.get(tabId)
    if (!page) return
    const css = this.themeCssFor(tabId)
    if (!force && this.appliedTheme.get(tabId) === css) return
    this.appliedTheme.set(tabId, css)
    page.applyCss(css, 'theme')
  }

  protected refreshThemes(): void {
    for (const id of this.pages.keys()) this.applyThemeToPage(id)
  }

  toggleSidebar(): void {
    const visible = this.store.get().settings.sidebarVisible
    this.sidebarTrace.during('toggleSidebar', () => this.dispatch({ type: 'settings/update', patch: { sidebarVisible: !visible } }))
  }
}
