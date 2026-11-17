// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). What is applied to a site: the hot edge, Tweaks,
// user scripts and fonts, the Eraser layer, the erasure of site data, the readable mode and the look of the window.

import { randomBytes } from 'node:crypto'
import { FLOAT_LEAVE_MS } from '@shared/ipc'
import type { Boost, SidebarState, TabItem } from '@shared/model'
import { boostRunsScript, scriptPreview, scriptPreviewMessage, scriptSwitchedOff, type ScriptPreviewReply, bundledFaceName, bundledFontsOf, combineBoosts, missingFacesScript, zapScript, zapSelectors, zapStopName, zapStopScript, type BoostFont } from '@shared/boost'
import { activeProfileId } from '@shared/profiles'
import { PRIVATE_BACKGROUND } from '@shared/private-window'
import { chosenZoomOf } from '@shared/site-zoom'
import { DARK_PROBE_SCRIPT, applyReadable, probePage, readableKey, readablePlan, type ReadablePlan } from '@shared/dark-sites'
import { readableInUse, readableModeFor } from '@shared/readable-mode'
import { windowLookKey } from '@shared/window-look'
import { edgeOpensFloatingSidebar } from '@shared/window-sidebar'
import { activeTab, type Action } from '@shared/sidebar'
import { matchesHost } from '@shared/url'
import { normalizeSiteDataPrefs, parseSiteHost, quickClearRequest, rememberSiteHosts, siteOrigins, type SiteDataBatchRequest, type SiteDataRequest, type SiteDataResult, type SiteDataSiteResult } from '@shared/site-data'
import { pageAnimation } from '@shared/site-data-overlay'
import type { Page } from '../engine/types'
import { wrapUserScript } from '@shared/userscript'
import { userScripts } from '../userscripts'
import { fontScript } from './boost-fonts'
import { animationPageOf, clearSiteFor, clearSitesFor, clearSitesWithAnimation, runAndTell, type AnimatedPage, type RunReport, type SiteDataEnvironment } from './site-data'
import { prefersReducedMotion } from './motion'
import { describeClearFailure, sitesToClearOnClose, sitesToClearOnQuit, type ClearOnCloseJob } from '@shared/site-clear'
import { showSystemNotice } from './system-notice'
import { currentPlatform } from '../platform'
import { t } from '@shared/i18n'
import { FLOAT_HIDE_DELAY_MS, NO_HISTORY, WINDOW_BACKGROUND } from './browser-base'
import { BrowserCapture } from './browser-capture'

export abstract class BrowserSite extends BrowserCapture {
  // ---- floating sidebar (sidebar hidden, pointer at the left edge) ----

  /** Makes the view of the floating sidebar now, as hiding the sidebar does (for the engine test, which tries every surface of the interface). */
  prepareFloatingSidebar(): void {
    this.floating.ensure()
  }

  hotEdge(inside: boolean): void {
    // Only a window with no sidebar on screen has an edge to touch: the column of a docked sidebar is one (shared/window-sidebar.ts).
    if (!edgeOpensFloatingSidebar(this.store.get().settings, this.sidebarChoice) || this.fullscreenTab !== null) {
      if (inside) this.sidebarTrace.edgeEvent('ignored', this.sidebarFacts())
      return
    }
    if (this.floatTimer) clearTimeout(this.floatTimer)
    this.floatTimer = null
    if (inside) {
      // Made when the sidebar was hidden; made here should the edge come first.
      this.floating.ensure()
      this.floatVisible = true
      this.floatPhase = 'in'
      this.sidebarTrace.edgeEvent('opened', this.sidebarFacts())
      this.layout()
      this.publish()
    } else if (this.floatVisible) {
      this.sidebarTrace.edgeEvent('closing', this.sidebarFacts())
      // The panel goes as soon as the pointer leaves it, in about 0.1 s.
      this.floatTimer = setTimeout(() => {
        this.floatPhase = 'out'
        this.publish()
        this.floatTimer = setTimeout(() => {
          this.floatTimer = null
          this.floatVisible = false
          this.floatPhase = null
          this.sidebarTrace.edgeEvent('gone', this.sidebarFacts())
          this.layout()
          // The surface of the floating sidebar draws nothing once `floating` is gone from the snapshot: it has to be told.
          this.publish()
        }, FLOAT_LEAVE_MS)
      }, FLOAT_HIDE_DELAY_MS)
    }
  }

  // ---- Tweaks (per-site CSS and JS) ----

  /**
   * Every enabled Tweak whose host matches the page, in the order they were created. None for a private tab, even of a normal window: a private
   * window has no Tweak at all (its state keeps none), and a private tab is held to the same rule.
   */
  private boostsFor(tab: Pick<TabItem, 'url' | 'private'>): Boost[] {
    if (tab.private === true) return []
    const state = this.store.get()
    return state.settings.boostsEnabled ? state.boosts.filter((b) => b.enabled && matchesHost(b.host, tab.url)) : []
  }

  protected applyBoost(tabId: string, runScript: boolean): void {
    const page = this.pages.get(tabId)
    const tab = this.store.get().tabs.find((t) => t.id === tabId)
    if (!page || !tab) return
    const boosts = this.boostsFor(tab)
    const { css, scripts, zoom } = combineBoosts(boosts)
    page.applyCss(css)
    const fonts = bundledFontsOf(boosts)
    if (fonts.length > 0) void this.giveFonts(tabId, page, fonts)
    // The Tweak's text size sets the base; the zoom the user chose (⌘+ ⌘−) comes on top of it: the site's, or the tab's own for a page that has no host.
    page.setZoom(zoom * chosenZoomOf(tab, this.store.get().settings.siteZoom, this.volatileZoom.get(tabId)))
    if (runScript) for (const script of scripts) page.runScript(script)
  }

  /**
   * The preview of the Tweak editor: the script as it is typed (or the saved one when nothing is being typed) is run once in the page the
   * person is looking at, because they asked. Nothing is stored by it: the pages go on running the saved script only. The rules are
   * `scriptPreview`'s; the answer is the sentence the editor shows.
   */
  previewBoostScript(boostId: string): ScriptPreviewReply {
    const state = this.store.get()
    const boost = state.boosts.find((b) => b.id === boostId)
    const tab = activeTab(state)
    const page = tab ? this.pages.get(tab.id) : undefined
    const preview = scriptPreview(boost, tab && page && boost ? { matches: matchesHost(boost.host, tab.url), private: tab.private === true || this.isPrivate() } : undefined, state.settings.boostsEnabled)
    if (preview.ok) page!.runScript(preview.js)
    else console.warn(`[boost] the preview of the script of Tweak ${boostId} was not run: ${preview.reason}`)
    return { ok: preview.ok, message: scriptPreviewMessage(preview, boost) }
  }

  /**
   * The user scripts the user turned on that match this page, run where a Tweak's JavaScript runs: once the document is ready.
   * With the manager switched off nothing is read and nothing runs. A script that fails is logged and shown in the list of Settings.
   * A private tab of a normal window is held to the rule of a private window: only the scripts the user allowed there.
   */
  protected applyUserScripts(tabId: string): void {
    if (!this.store.get().settings.userScripts) return
    const page = this.pages.get(tabId)
    const tab = this.store.get().tabs.find((t) => t.id === tabId)
    if (!page || !tab) return
    const manager = userScripts()
    for (const script of manager.matching(tab.url, this.isPrivate() || tab.private === true)) {
      page.evaluate(wrapUserScript(script)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[userscripts] "${script.name}" (${script.id}) failed on tab ${tabId}:`, message)
        manager.recordFailure(script.id, message)
      })
    }
  }

  /**
   * Gives a page the bundled fonts its Tweaks ask for (the CSS names them, the page must have them): only the ones this document does not
   * have yet, since the document changes with every navigation and the same edit may come many times (a slider being dragged).
   */
  private async giveFonts(tabId: string, page: Page, fonts: BoostFont[]): Promise<void> {
    try {
      const missing = await page.evaluate(missingFacesScript(fonts.map((font) => bundledFaceName(font) as string)))
      if (!Array.isArray(missing)) return
      for (const font of fonts) {
        if (!missing.includes(bundledFaceName(font))) continue
        const added = await page.evaluate(await fontScript(font))
        if (added === false) console.warn(`[boost] the page of tab ${tabId} refused the font ${font.label}`)
      }
    } catch (error) {
      // The page is gone or navigating (nothing to give), or the file cannot be read: the text keeps the fallback fonts of its stack.
      console.warn(`[boost] cannot give the fonts to tab ${tabId}:`, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * The Eraser mode: the editor stays (its layer shrinks to the panel) while the page gets a blue frame, a hint and a "Terminé"
   * button; every element the user clicks is hidden and its selector joins the Tweak's list. The mode ends with that button, with
   * Escape, or when the editor is closed; the editor then comes back. The Tweak already exists: the editor saves it before asking.
   */
  async startZap(host: string, boostId: string): Promise<void> {
    const page = this.activePage()
    if (!page || this.zapping) return this.closeOverlay()
    const stop = zapStopName(randomBytes)
    this.zapping = { page, stop }
    this.openOverlay({ panel: 'boost', host, id: boostId, zap: true })
    let picked: unknown
    try {
      picked = await page.evaluate(zapScript(stop))
    } catch (error) {
      // Navigating away rejects the script: the mode is over, whatever was picked is lost with the page.
      console.error('[boost] the Eraser ended with an error:', error instanceof Error ? error.message : String(error))
    } finally {
      this.zapping = null
    }
    const boost = this.store.get().boosts.find((b) => b.id === boostId)
    if (boost) {
      const zap = zapSelectors(boost.zap, picked)
      if (zap.length !== boost.zap.length || zap.some((z, i) => z !== boost.zap[i])) this.dispatch({ type: 'boost/save', boost: { ...boost, zap } })
    }
    // The editor comes back at its size (unless it was closed on purpose), with the picks in its list.
    if (this.overlayRequest?.panel === 'boost') this.openOverlay({ panel: 'boost', host, id: boostId })
  }

  /** Ends the Eraser mode from outside the page (the editor was closed or left the mode). */
  endZap(): void {
    const zapping = this.zapping
    if (!zapping) return
    void zapping.page.evaluate(zapStopScript(zapping.stop)).catch((error: unknown) => console.error('[boost] cannot end the Eraser:', error instanceof Error ? error.message : String(error)))
  }

  /** Removes the current site's cookies and storage (this profile only), then reloads it. */
  async clearSiteData(): Promise<void> {
    const tab = activeTab(this.store.get())
    const page = tab ? this.pages.get(tab.id) : undefined
    if (!tab || !page || !URL.canParse(tab.url)) return
    const site = parseSiteHost(new URL(tab.url).host)
    if (!site) return
    const space = this.store.get().spaces.find((s) => s.id === tab.spaceId)
    // A private tab's cookies are in the private context, not in its space's profile.
    const results = await this.engineOf(tab).clearSiteData(space?.profileId ?? 'default', { origins: siteOrigins(site.host), host: site.host, subdomains: false, types: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'] })
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) throw new Error(`Cannot clear ${failed.map((r) => `${r.type} (${r.error})`).join(', ')}`)
    page.reload()
  }

  /** "Effacer les données du site…": erases what the request asks for, in the profile of the current space (see shell/site-data.ts). */
  clearSiteDataFor(request: SiteDataRequest): Promise<SiteDataResult[]> {
    return clearSiteFor(this.siteDataEnvironment(), request)
  }

  /**
   * "Effacer les données du site…" for several sites at once: the same types and options for each, one result per site. The sites
   * are remembered afterwards for one-click reuse, whatever the outcome (a site that failed is the one to try again). A private
   * window remembers nothing: its `dispatch` refuses a setting it does not own (see private-window.ts). The run is the user's (the
   * sheet, the shortcut, a menu): the page of the tab it started from shows the chosen animation (never at close or quit), the sheet stepping
   * aside while it plays, and the tab goes back to the root of the site once it is over (see `clearSitesWithAnimation`).
   */
  async clearSitesFor(request: SiteDataBatchRequest, tabId?: string): Promise<SiteDataSiteResult[]> {
    const settings = this.store.get().settings
    const animation = pageAnimation(settings.siteDataAnimation, { reducedMotion: settings.forceReduceMotion || prefersReducedMotion() })
    const sites = await clearSitesWithAnimation(this.siteDataEnvironment(tabId), request, {
      page: this.animatedPage(tabId),
      animation,
      // A sheet that closes at once (« Fermeture auto ») has nothing to step aside from.
      ...(request.detached ? {} : { stepAside: () => this.stepSheetAside() }),
      active: () => this.siteDataEnvironment(tabId).active
    })
    // The sites of a private tab are not written to the settings.
    const asked = tabId ? this.store.get().tabs.find((t) => t.id === tabId) : activeTab(this.store.get())
    if (asked?.private === true) return sites
    const recents = this.store.get().settings.siteDataRecents
    const next = rememberSiteHosts(recents, request.hosts)
    if (next.join(' ') !== recents.join(' ')) this.dispatch({ type: 'settings/update', patch: { siteDataRecents: next } })
    return sites
  }

  /**
   * The sheet « Effacer les données du site » out of sight while the page animates: its layer is hidden, not closed, so that it comes back as it was
   * (running, then with the answer). Answers what brings it back, which does nothing when the sheet was closed or replaced by another panel meanwhile.
   */
  private stepSheetAside(): () => void {
    const sheet = this.overlayRequest
    if (sheet?.panel !== 'sitedata') return () => undefined
    this.overlay.setVisible(false)
    return () => {
      if (this.overlayRequest !== sheet) return
      this.overlay.setVisible(true)
      this.overlay.webContents.focus()
    }
  }

  /** The page of the tab a run starts from (else the one on screen), when it shows a web page the animation can be drawn on. */
  private animatedPage(tabId?: string): AnimatedPage | null {
    const state = this.store.get()
    const tab = tabId ? state.tabs.find((t) => t.id === tabId) : activeTab(state)
    return animationPageOf(tab?.url, tab ? this.pages.get(tab.id) : undefined)
  }

  /** A run nobody watches (the panel closed at once): it ends in the background and tells how it went. */
  async clearSitesInBackground(request: SiteDataBatchRequest): Promise<void> {
    await runAndTell(this.runReport(), request)
  }

  /**
   * The shortcut and the menu entries that clear the site of a page without a panel: the choices the panel remembered, then a notice.
   * A page that has no site (a start page, the settings, a file) is told so instead of being cleared.
   */
  async quickClearSite(tabId?: string): Promise<void> {
    const state = this.store.get()
    const tab = tabId ? state.tabs.find((t) => t.id === tabId) : activeTab(state)
    const request = tab ? quickClearRequest(tab.url, normalizeSiteDataPrefs(state.settings), { private: this.isPrivate() || tab.private === true }) : null
    if (!tab || !request) return this.showToast(t('browser.cette-page-n-a-pas-de-donnees-de-site-a-effacer'))
    await runAndTell(this.runReport(tab.id), request)
  }

  private runReport(tabId?: string): RunReport {
    return {
      run: (request) => this.clearSitesFor(request, tabId),
      notify: () => this.store.get().settings.siteDataNotify,
      // A private tab's notices are as discreet as a private window's: the system's notification centre is not private.
      private: this.isPrivate() || (tabId !== undefined ? this.store.get().tabs.find((t) => t.id === tabId)?.private === true : activeTab(this.store.get())?.private === true),
      notice: showSystemNotice,
      toast: (message) => this.showToast(message)
    }
  }

  /**
   * The sites whose last tab this change closed: their data goes (see site-clear.ts). A private window has nothing to erase. `before` is the state of
   * every window (`store.root()`): with windows of their own, a tab of the site in another window keeps its data.
   */
  protected clearOnClose(before: SidebarState): void {
    for (const job of sitesToClearOnClose(before, this.store.root().get(), { private: this.isPrivate() })) {
      // One after the other: two tabs closed in a row on the same site must not race each other in the cookie jar.
      this.clearTail = this.clearTail.then(() => this.runClearJob(job)).then(() => undefined)
    }
  }

  /** One profile's share of an erasure at close or quit. A failure is logged with its context and told to the user, never swallowed. */
  private async runClearJob(job: ClearOnCloseJob): Promise<string[]> {
    try {
      const sites = await clearSitesFor(this.siteDataEnvironment(undefined, job.profileId), job.request)
      const failed = sites.filter((site) => site.results.length === 0 || site.results.some((r) => !r.ok)).map((site) => site.host)
      if (failed.length > 0) {
        console.error(`[site] the data of ${failed.join(', ')} was not fully erased at close:`, JSON.stringify(sites.filter((site) => failed.includes(site.host))))
        this.tellClearFailure(describeClearFailure(failed))
      }
      return failed
    } catch (error) {
      console.error('[site] cannot erase the data of the closed sites:', error)
      this.tellClearFailure(describeClearFailure(job.request.hosts))
      return job.request.hosts
    }
  }

  /** The toast of a failed erasure. The window may already be gone (the erasure at quit): then the log above is all there is. */
  private tellClearFailure(message: string): void {
    try {
      this.showToast(message)
    } catch (error) {
      console.error('[site] cannot show the notice of a failed erasure:', message, error)
    }
  }

  /** "Aussi à la fermeture de Lucium": the listed sites in every profile, when the setting asks for it. Resolves with the sites that were not fully erased. */
  async clearSitesOnQuit(): Promise<string[]> {
    await this.clearTail
    const failed: string[] = []
    for (const job of sitesToClearOnQuit(this.store.get(), { private: this.isPrivate() })) failed.push(...(await this.runClearJob(job)))
    return failed
  }

  /** Waits for the erasures started by closed tabs (the engine test reads the outcome; quitting must not cut one short). */
  clearingSettled(): Promise<void> {
    return this.clearTail
  }

  siteCookieCount(host: string, subdomains: boolean): Promise<number> {
    return this.engineOf(activeTab(this.store.get())).siteCookieCount(activeProfileId(this.store.get()), host, subdomains)
  }

  /** What the site-data erasure reaches: the engine session of the current profile, and the pages open in it (in every window of the group). */
  private siteDataEnvironment(tabId?: string, profile?: string): SiteDataEnvironment {
    const state = this.store.get()
    const profileId = profile ?? activeProfileId(state)
    const spaces = new Set(state.spaces.filter((s) => s.profileId === profileId).map((s) => s.id))
    // The tab the run was started from (a page's own menu), else the one the user is looking at. A run for a whole profile (at close or at quit) has
    // none: whatever tab is active (a private one, one in a container) must not decide which context is erased.
    const current = profile !== undefined ? undefined : tabId ? state.tabs.find((t) => t.id === tabId) : activeTab(state)
    // A private tab's data is in the private context, and its pages are the private ones: the profile's cookies, pages and history are left alone.
    // The same goes for a tab in a container, whose data is the container's and whose pages are the ones of that container.
    const isolated = current?.private === true && !this.isPrivate()
    const container = this.containerKeyOf(current)
    const tabs: SiteDataEnvironment['tabs'] = []
    for (const browser of this.group) {
      for (const [id, page] of browser.pages) {
        const tab = state.tabs.find((t) => t.id === id)
        if (tab && (tab.private === true) === isolated && browser.containerKeyOf(tab) === container && (isolated || container !== '' || spaces.has(tab.spaceId))) tabs.push({ url: tab.url, page })
      }
    }
    const currentPage = current ? this.pages.get(current.id) : undefined
    return {
      clear: (request) => this.engineOf(current).clearSiteData(profileId, request),
      history: isolated || container !== '' ? NO_HISTORY.of(profileId) : this.history.of(profileId),
      // As for the history above: the data of a private tab or of a container is not the profile's, and neither are its pages in the Back lists.
      closedPages: { removeSite: (host, subdomains) => (isolated || container !== '' ? undefined : this.forgetClosedPages(profileId, { host, subdomains })) },
      tabs,
      active: current && currentPage ? { url: current.url, page: currentPage } : null
    }
  }

  /**
   * A Tweak was saved, brought in or deleted (`before`: the state the action was applied to). A draft, the save of an editor that is still open on
   * a script, is stored and its stylesheet shown, but reloads nothing: a page reloaded at every pause in the typing could not be worked on. The
   * reloads it owes are made by the next change that is not a draft, the one the editor sends as it closes.
   */
  protected boostsChanged(action: Extract<Action, { type: 'boost/save' | 'boost/delete' | 'boost/import' }>, before: SidebarState): void {
    // A script switched off keeps running in the page that has it until that page is a new document.
    const saved = action.type === 'boost/save' ? action.boost : undefined
    const stopped = saved && scriptSwitchedOff(before.boosts.find((b) => b.id === saved.id), this.store.get().boosts.find((b) => b.id === saved.id)) ? [saved.host] : []
    if (action.type === 'boost/save' && action.draft === true) {
      this.stoppedByDrafts = [...this.stoppedByDrafts, ...stopped]
      for (const browser of this.group) browser.refreshBoostsHere([], false)
      return
    }
    const owed = this.stoppedByDrafts
    this.stoppedByDrafts = []
    this.refreshBoosts([...owed, ...stopped])
  }

  /** After an edit: CSS is swapped live; a script only runs on a fresh document, so reload pages that have one. */
  protected refreshBoosts(stoppedHosts: readonly string[] = []): void {
    for (const browser of this.group) browser.refreshBoostsHere(stoppedHosts)
  }

  private refreshBoostsHere(stoppedHosts: readonly string[], reload = true): void {
    for (const tab of this.store.get().tabs) {
      const page = this.pages.get(tab.id)
      if (!page) continue
      this.applyBoost(tab.id, false)
      if (!reload) continue
      // A private tab runs no Tweak's script, so there is nothing to run again or to stop in it.
      if (tab.private === true) continue
      // A script that runs is run again by a new document; one that was just switched off is stopped by it. A script that waits runs nowhere.
      if (this.boostsFor(tab).some(boostRunsScript) || stoppedHosts.some((host) => matchesHost(host.trim().toLowerCase().replace(/^www\./, ''), tab.url))) page.reload()
    }
  }

  // ---- readable mode (nothing runs for a page while every site is on Original) ----

  /**
   * Gives a page what its readable mode asks for, or takes it back (see dark-sites.ts: `readablePlan`, `applyReadable`). A page that already is
   * what the mode asks, or that cannot say what it looks like, is left as it is. The answer of the page comes late: a newer call, or a page that
   * went away, cancels it. The probe and the engine run in the page's readable world, which the page cannot reach. (The slot is still called
   * `dark`, as it was when this was the forced dark mode alone.)
   */
  protected applyDarkToPage(tabId: string): void {
    const settings = this.store.get().settings
    // The common case, kept free: no site has a mode and this page never got anything.
    if (!readableInUse(settings) && !this.appliedDark.has(tabId)) return
    const page = this.pages.get(tabId)
    const tab = this.store.get().tabs.find((t) => t.id === tabId)
    if (!page || !tab) return
    const generation = (this.darkScans.get(tabId) ?? 0) + 1
    this.darkScans.set(tabId, generation)
    const current = (): boolean => this.darkScans.get(tabId) === generation && this.pages.get(tabId) === page
    // A page without a readable world (none in the application: every page has one) cannot be read, so it is left as it is.
    const run = (code: string): Promise<unknown> => (page.runReadable ? page.runReadable(code) : Promise.reject(new Error('the page has no readable world')))
    const give = (plan: ReadablePlan | null): void => {
      const key = readableKey(plan)
      const had = this.appliedDark.get(tabId) ?? ''
      if (had === key) return
      this.appliedDark.set(tabId, key)
      void applyReadable({ applyCss: (css) => page.applyCss(css, 'dark'), run }, plan, { had: had !== '', current, warn: (message) => console.warn(message), context: `tab ${tabId}` })
    }
    // A PDF is drawn by the viewer: its frame says so whatever the address, and the probe tells a PDF by its MIME type (see dark-sites.ts).
    const mode = readableModeFor(settings, tab.url, this.systemDark)
    if (mode === 'original' || page.showsPdfViewer?.()) return give(null)
    void probePage(() => run(DARK_PROBE_SCRIPT), (message) => console.warn(message), `tab ${tabId}`).then((look) => {
      if (!current() || look.verdict === 'unknown') return
      give(page.showsPdfViewer?.() === true ? null : readablePlan(mode, look))
    })
  }

  /** Whether the page of a tab is drawn by the PDF viewer, whatever its address: the toolbar button « Contraste de la page » does nothing there (page-commands.ts). */
  showsPdf(tabId: string): boolean {
    return this.pages.get(tabId)?.showsPdfViewer?.() === true
  }

  protected refreshDark(): void {
    for (const browser of this.group) browser.refreshDarkHere()
  }

  protected refreshDarkHere(): void {
    for (const id of this.pages.keys()) this.applyDarkToPage(id)
  }

  // ---- the look of the window (vibrancy and a translucent background; the opaque window until a setting says otherwise) ----

  /**
   * Gives the windows of the group the material and the transparent background the settings ask for. Only a change of the material or
   * of whether the background is translucent reaches the window: the percentage itself is drawn by the interface.
   */
  protected applyWindowLook(): void {
    for (const browser of this.group) browser.applyWindowLookHere()
  }

  protected applyWindowLookHere(): void {
    const settings = this.store.get().settings
    const key = windowLookKey(settings)
    if (key === this.windowLook) return
    this.windowLook = key
    if (this.win.isDestroyed()) return
    try {
      // The material sits behind the web contents: the contents must be transparent for it to show, and opaque again without it.
      const clear = key.endsWith('|clear')
      currentPlatform().applyVibrancy(this.win, settings.windowVibrancy)
      this.win.setBackgroundColor(clear ? '#00000000' : this.options.private && this.options.guest !== true ? PRIVATE_BACKGROUND : WINDOW_BACKGROUND)
    } catch (error) {
      console.error(`[window] cannot apply the window look ${key}:`, error instanceof Error ? error.message : String(error))
    }
  }

  /** The window look the window really has, for the engine test. */
  currentWindowLook(): string {
    return this.windowLook
  }
}
