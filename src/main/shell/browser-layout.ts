// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). Where everything goes on screen: the sync of the
// views with the state, the stage, the split view, the overlay, the traffic lights, the sliding sidebar.

import { Menu, screen, type View } from 'electron'
import { FIND_PANEL, FIND_REPLACE_PANEL, PEEK_HEADER_HEIGHT, TOOLBAR_BAR_HEIGHT, type OverlayRequest } from '@shared/ipc'
import type { SplitView } from '@shared/model'
import { ZAP_PANEL } from '@shared/boost'
import { PEEK_BORDER, PEEK_PAGE_RADIUS, peekPageRect } from '@shared/peek'
import { DOCK_WIDTH, floatingBox, frameLayout, stageTop, trafficLightsAt, type Frame } from '@shared/frame-layout'
import { fullscreenAfterSync } from '@shared/html-fullscreen'
import { resolveAppearance } from '@shared/theme'
import { findLayerBounds, scaled, uiFactor } from '@shared/ui-scale'
import { PANEL_NEED, panelFactor, panelIsScaled, screenOf } from '@shared/panel-scale'
import { opensPlayer } from '@shared/media-player'
import { hostOf } from '@shared/url'
import { visibleTabIds } from '@shared/window-selection'
import { pageRadius, paneContent, splitLayout, splitPaneStage } from '@shared/split'
import { runtimeOfTabs } from '@shared/lock'
import { withSleepingEntries } from '@shared/sleep'
import { CYCLE_PANEL, cyclePanelWidth } from '@shared/tab-cycle'
import { toolbarIsLight } from '@shared/toolbar'
import { appMenuAnchor, controlsOverlay } from '@shared/window-controls'
import { pageMargin } from '@shared/window-look'
import { activeTab, splitFor } from '@shared/sidebar'
import { PERMISSION_LAYER } from '@shared/permissions'
import type { Bounds } from '../engine/types'
import { prefersReducedMotion } from './motion'
import { batterySaver } from './battery-saver'
import { currentPlatform } from '../platform'
import { popupApplicationMenu } from './app-menu-popup'
import { SIDEBAR_SLIDE_MS, SIDEBAR_SLIDE_STEP_MS, THEME_MAX_HEIGHT, THEME_WIDTH } from './browser-base'
import { BrowserPages } from './browser-pages'
import { FullscreenNotice } from './fullscreen-notice'

export abstract class BrowserLayout extends BrowserPages {
  /** The site and Escape, said for a few seconds over a page that took the window in full screen (shared/fullscreen-notice.ts). */
  protected readonly fullscreenNotice = new FullscreenNotice(this.win, () => this.layout())

  /** The view of the notice over a page in full screen, while it is on screen (the engine test looks at it). */
  fullscreenNoticeForTest(): ReturnType<FullscreenNotice['current']> {
    return this.fullscreenNotice.current()
  }

  /** Reconciles live web views with the persisted state. Idempotent. */
  protected sync(): void {
    this.configureExtensions()
    const state = this.store.get()
    // The page the active tab has now: if this sync leaves it another one (rebuilt), the extension runtime is told (see the end).
    const activeId = activeTab(state)?.id
    const pageBefore = activeId === undefined ? undefined : this.pages.get(activeId)
    const tabIds = new Set(state.tabs.map((t) => t.id))
    for (const id of [...this.pages.keys()]) if (!tabIds.has(id)) this.destroyPage(id)
    // A sleeping tab keeps an `awake: false` entry that no page remains to remove once the tab is closed.
    this.runtime = runtimeOfTabs(this.runtime, state)
    // A tab that has had no page yet (left asleep at the launch, opened behind) has that entry too: it reads as asleep everywhere, as a tab put to sleep does.
    this.runtime = withSleepingEntries(this.runtime, state.tabs)
    this.rebuildPagesOfChangedSession(state)
    this.reopened.forget(tabIds)
    // Only the leader holds the lists of the sleeping tabs, and its state names every tab of the group.
    if (this.leader === this) this.slept.forget(tabIds)
    // The last private tab is gone: its session goes with it.
    this.leader.releasePrivateContext()
    this.syncCycleWatch()
    if (this.cycleWatching) for (const id of [...this.usedAt.keys()]) if (!tabIds.has(id)) this.usedAt.delete(id)

    const active = activeTab(state)
    const previous = this.shownTabId
    const nextVisible = new Set(this.visibleIds())

    for (const id of this.visible) {
      if (nextVisible.has(id)) continue
      this.pages.get(id)?.hide()
      this.idleSince.set(id, Date.now())
    }
    if (previous && previous !== active?.id) {
      // The order of use of ⌃Tab counts the moment a tab was left.
      if (this.cycleWatching) this.usedAt.set(previous, Date.now())
      // A search belongs to the page it was started on.
      if (this.find) this.endFind()
      const left = this.pages.get(previous)
      // A page that never loaded anything has no video to float (and no render frame to ask yet). A tab whose video is in Lucium's floating window
      // has its picture already: neither the system's nor the media player is opened for it.
      if (left && this.committed.has(previous) && !nextVisible.has(previous) && this.leader.floatingVideo?.floatingTab() !== previous) {
        // A video being watched floats (shared/auto-pip.ts), unless its site had its floating window closed too often this session; the player
        // is for the rest that makes sound (a sound alone, a video the page keeps from floating, a small one, or the setting off).
        const wantsPlayer = state.settings.mediaPlayer && opensPlayer(this.runtime.tabs[previous])
        const site = hostOf(state.tabs.find((t) => t.id === previous)?.url ?? '')
        if (state.settings.autoPictureInPicture && this.leader.autoPip.allows(site)) {
          void left.setPictureInPicture(true, 'tab-switch').then(
            (entered) => {
              if (entered) this.leader.autoPip.floated(previous, site)
              else if (wantsPlayer) this.openMediaPlayer(previous)
            },
            (error: unknown) => {
              console.error('[pip] cannot enter Picture in Picture:', error)
              if (wantsPlayer) this.openMediaPlayer(previous)
            }
          )
        } else if (wantsPlayer) {
          // This sync publishes when it ends.
          this.openMediaPlayer(previous, false)
        }
      }
    }
    this.visible = nextVisible
    // A page in full screen that is no longer on show (another tab, another space) gives the window back: the window must not stay in full screen behind another page.
    const fullscreen = fullscreenAfterSync(this.fullscreenTab, nextVisible)
    this.fullscreenTab = fullscreen.tab
    if (fullscreen.leave !== null) void this.leaveHtmlFullscreen(fullscreen.leave)
    // A tab another window shows now: its page goes there as it is (a call goes on); one that cannot go is a stale copy here, so it goes (the tab reloads there).
    if (this.group.size > 1) {
      const others = [...this.group].filter((b) => b !== this)
      const elsewhere = new Set(others.flatMap((b) => visibleTabIds(b.store.get())))
      for (const id of [...this.pages.keys()]) {
        if (nextVisible.has(id) || !elsewhere.has(id)) continue
        const taker = others.find((b) => visibleTabIds(b.store.get()).includes(id))
        // The tab goes on in the other window: the page made there gets the Back / Forward list of this one.
        if (!taker?.adoptPage(this, id)) this.destroyPage(id, true)
      }
    }

    const changed = previous !== (active?.id ?? null)
    this.shownTabId = active?.id ?? null
    // The questions that waited for a tab to be on screen (a login, a permission, a box of prompt()) are put now that it is.
    this.showWaitingQuestions()
    // A tab that comes on screen is shown with its current icon: its dot goes, and the icon it has now is the base.
    if (changed && this.shownTabId) this.showIcon(this.shownTabId, state.tabs.find((t) => t.id === this.shownTabId)?.faviconUrl)
    // The unread badge a title has already taken back, which was only held, goes when the tab comes on screen: it is read.
    if (changed && this.shownTabId && this.unread.appeared(this.shownTabId)) this.refreshUnread(this.shownTabId)
    if (this.iconBase.size > state.tabs.length) for (const id of [...this.iconBase.keys()]) if (!state.tabs.some((t) => t.id === id)) this.iconBase.delete(id)
    // An empty tab that was left goes (shell/blank-tab-watch.ts); the summary tabs that are gone are forgotten.
    const tabsNow = this.store.get().tabs
    for (const id of [...this.summaryTabs]) if (!tabsNow.some((t) => t.id === id)) this.summaryTabs.delete(id)
    this.blankTabs.watch(previous, this.shownTabId)
    if (changed) this.reconcileSidePanel()
    this.reconcileWebPanel()
    for (const id of nextVisible) {
      const tab = state.tabs.find((t) => t.id === id)
      // A sync triggered while this tab's page is still being created is finished by the outer call.
      if (tab && !this.creating.has(id)) {
        // The live page another window holds for this tab comes here as it is rather than being made again (that window may not have synced yet).
        const owner = this.pages.has(id) ? undefined : this.ownerOf(id)
        if (owner) this.adoptPage(owner, id)
        this.ensurePage(tab)
      }
      // Showing a frozen page wakes it: the sidebar stops dimming it, and the page runs again with the state it had.
      if (this.frozen.has(id)) void this.thawPage(id)
      // A page that loaded off screen has its colour read now that its bar shows it (onPageUpdate).
      if (this.colorUnread.delete(id)) void this.refreshPageColor(id)
    }
    this.refreshThemes()
    // The editor is tied to one space: leaving that space ends the edit.
    if (this.overlayRequest?.panel === 'theme' && this.overlayRequest.spaceId !== state.activeSpaceId) this.closeOverlay()
    this.layout()
    if (active && changed) {
      // Its video floats in Lucium's window: choosing the tab brings that window back in front (the place of its page offers to bring the video back).
      if (this.leader.floatingVideo?.floatingTab() === active.id) this.leader.floatingVideo.show()
      const page = this.pages.get(active.id)
      if (page) {
        this.engine.activatePage(active.id)
        if (this.committed.has(active.id)) {
          // A window the automatic picture opened for this tab that no longer floats was closed while the tab was away: the site is told so.
          const floatedSite = this.leader.autoPip.returning(active.id)
          void page.setPictureInPicture(false).then(
            (wasFloating) => (floatedSite !== null && !wasFloating ? this.leader.autoPip.closed(floatedSite) : undefined),
            (error: unknown) => console.error('[pip] cannot leave Picture in Picture:', error)
          )
        }
        if (!this.overlayRequest) page.focus()
      }
    } else if (active && this.pages.has(active.id) && this.pages.get(active.id) !== pageBefore) {
      // The same tab with a new page (made again for the autoplay rule, a container, a profile…): the extensions' idea of the active tab is the page that is gone.
      this.engine.activatePage(active.id)
    }
    this.pruneMediaPlayers()
    this.autoReloader?.refresh()
    this.refreshPageTools()
    // The saver's setting is the main window's; every window reacts to the mode through the subscription made at `start`.
    if (!this.isPrivate() && !this.isSecondary()) batterySaver().configure(state.settings.batterySaver)
    this.pageWatcher?.refresh()
    this.publish()
  }

  /**
   * The left edge of the page card. It is `target`, except for about 0.1 s after the sidebar was hidden or shown: then it slides there
   * with the sidebar (the interface slides the same way, in CSS). A change of the sidebar's width (its edge dragged) is never animated.
   */
  private cardLeft(visible: boolean, target: number): number {
    const seen = this.slideSeen
    if (!seen) {
      this.slideSeen = { visible, left: target }
      return target
    }
    if (seen.visible !== visible) {
      const from = this.slide ? this.currentSlideLeft(this.slide) : seen.left
      this.slideSeen = { visible, left: target }
      if (this.slideEnabled && !prefersReducedMotion()) this.startSlide(from, target)
      else this.endSlide()
    } else if (!this.slide) {
      seen.left = target
    } else {
      // The target moved while sliding (the width was set again): follow it.
      this.slide.to = target
      seen.left = target
    }
    return this.slide ? this.currentSlideLeft(this.slide) : target
  }

  private currentSlideLeft(slide: { from: number; to: number; start: number }): number {
    const t = Math.min(1, (Date.now() - slide.start) / SIDEBAR_SLIDE_MS)
    return Math.round(slide.from + (slide.to - slide.from) * (1 - (1 - t) ** 4))
  }

  private startSlide(from: number, to: number): void {
    if (this.slideTimer) clearInterval(this.slideTimer)
    const slide = { from, to, start: Date.now() }
    this.slide = slide
    this.slideTimer = setInterval(() => {
      if (this.slide !== slide) return
      if (Date.now() - slide.start >= SIDEBAR_SLIDE_MS) this.endSlide()
      this.layout()
    }, SIDEBAR_SLIDE_STEP_MS)
  }

  protected endSlide(): void {
    if (this.slideTimer) clearInterval(this.slideTimer)
    this.slideTimer = null
    this.slide = null
  }

  /**
   * Where the page goes: a card inset PAGE_MARGIN from the window edges, flush with the sidebar on its left, with the
   * toolbar above it when that is shown.
   */
  protected stageRect(): Bounds {
    return this.frame().stage
  }

  /**
   * The page card and the docked panel (shared/frame-layout.ts: the sidebar at the left, or the window mirrored). The side is this window's (its own choice,
   * else the setting), and a docked sidebar gives the card everything but its column.
   */
  private frame(): Frame {
    const { width, height } = this.win.getContentBounds()
    const settings = this.store.get().settings
    const { sidebarVisible, sidebarWidth, showToolbar } = settings
    const { right: sidebarRight, docked } = this.placement()
    // Every length of the interface is in CSS pixels; with the interface zoomed they take `k` times as many points (`scaled` is the identity at 100 %).
    const k = this.k()
    const margin = pageMargin(settings)
    const dock = this.dockWidth()
    return frameLayout({
      width,
      height,
      sideInset: this.cardLeft(sidebarVisible, scaled(docked ? DOCK_WIDTH : sidebarVisible ? sidebarWidth : margin, k)),
      sidebarRight,
      panelWidth: dock === null ? null : scaled(dock, k),
      top: scaled(stageTop({ showToolbar, toolbarLine: showToolbar && this.toolbarLine(), sidebarRight, docked, margin, controls: currentPlatform().facts.controlsOverlay }), k),
      margin: scaled(margin, k)
    })
  }

  // ---- size of the interface (Settings › Général › Taille de l’interface) ----

  /** The zoom of the interface surfaces: 1 at 100 %, the reference size. */
  protected k(): number {
    return uiFactor(this.store.get().settings.uiScale)
  }

  /** A rectangle of points on the screen, in the CSS pixels of the zoomed interface. */
  protected toCss(b: Bounds): Bounds {
    const k = this.k()
    return k === 1 ? b : { x: b.x / k, y: b.y / k, width: b.width / k, height: b.height / k }
  }

  /** A rectangle of CSS pixels of the interface, in points on the screen. */
  protected fromCss(b: Bounds): Bounds {
    const k = this.k()
    return k === 1 ? b : { x: Math.round(b.x * k), y: Math.round(b.y * k), width: Math.round(b.width * k), height: Math.round(b.height * k) }
  }

  /** The panes of a split view inside `stage`, in points: laid out in CSS pixels (gaps and strips are measured there), then scaled. */
  protected splitPanes(stage: Bounds, split: SplitView): Bounds[] {
    const panes = splitLayout(splitPaneStage(this.toCss(stage), split), split, undefined, TOOLBAR_BAR_HEIGHT)
    return this.k() === 1 ? panes : panes.map((pane) => this.fromCss(pane))
  }

  /**
   * The factor the panels of this window are scaled by, on top of the zoom of the interface: the choice of the screen the window is on (Settings › Apparence ›
   * Taille des fenêtres et des panneaux), « Automatique » when there is none, brought back to what the window holds (shared/panel-scale.ts). 1 when no screen
   * can be told.
   */
  protected panelK(): number {
    const screenOfWindow = screenOf(screen.getDisplayMatching(this.win.getBounds()))
    if (screenOfWindow === null) return 1
    return panelFactor({ sizes: this.store.get().settings.panelSizes, screen: screenOfWindow, room: this.win.getContentBounds(), need: PANEL_NEED, ui: this.k() })
  }

  /**
   * The zoom of the layer of panels: the zoom of the interface, times the factor of the panels while a panel that is laid out by its own CSS is open (a sheet or
   * a list in the middle of the window). A panel that hangs from the sidebar or the toolbar, or that the main process places (the find bar, the theme panel,
   * the command bar), keeps the zoom of the interface: the places the main process works out are in its CSS pixels (`PANEL_PLACEMENT`).
   */
  protected overlayZoom(): number {
    const k = this.k()
    const request = this.overlayRequest
    return request !== null && panelIsScaled(request) ? Math.round(k * this.panelK() * 1000) / 1000 : k
  }

  /**
   * Gives the three surfaces of this window's interface their zoom: the setting for the window and the floating sidebar, and for the layer the setting times the
   * factor of the panels while one of those is open. At 100 % nothing is touched unless a surface is found at another zoom (Chromium remembers the last one
   * for the file): then it is put back to 1.
   */
  protected syncUiZoom(force = false): void {
    // A window closed before its surfaces finished loading (a private window opened and closed at once): nothing left to zoom.
    if (this.win.isDestroyed()) return
    const k = this.k()
    const layer = this.overlayZoom()
    if (!force && this.uiZoom === k && this.layerZoom === layer) return
    this.uiZoom = k
    this.layerZoom = layer
    for (const [wc, factor] of [[this.win.webContents, k], [this.overlay.webContents, layer], [this.floating.current()?.webContents, k]] as const) {
      if (wc && !wc.isDestroyed() && Math.abs(wc.getZoomFactor() - factor) > 0.001) wc.setZoomFactor(factor)
    }
  }

  /**
   * Whether the 1 px line under the toolbar takes a row above the page: only under a light bar, and never in a split view (its
   * bars are always dark). The renderer draws the bar and its line from the same rule (`toolbarIsLight`).
   */
  protected toolbarLine(): boolean {
    const state = this.store.get()
    const active = activeTab(state)
    if (!active || splitFor(state, active.id)) return false
    const space = state.spaces.find((s) => s.id === active.spaceId)
    const appearance = space ? resolveAppearance(space.theme, this.systemDark) : 'dark'
    return toolbarIsLight(this.runtime.tabs[active.id]?.color, appearance)
  }

  private overlayBounds(request: OverlayRequest): Bounds {
    const window = this.win.getContentBounds()
    const stage = this.stageRect()
    // The sizes of the panels are in CSS pixels of the interface; the layer is placed in points.
    const f = (n: number) => scaled(n, this.k())
    // The panel's own size and offsets, plus a transparent margin for its shadow.
    if (request.panel === 'find') return findLayerBounds(stage, FIND_PANEL, this.k())
    if (request.panel === 'findreplace') return findLayerBounds(stage, FIND_REPLACE_PANEL, this.k())
    if (request.panel === 'theme') {
      // Beside the sidebar, so that it shows the theme live: at the card's left edge, or its right edge when the sidebar is at the right.
      const x = this.placement().right ? stage.x + stage.width - f(THEME_WIDTH) - f(12) : stage.x + f(12)
      return { x, y: stage.y + f(10), width: f(THEME_WIDTH), height: Math.min(f(THEME_MAX_HEIGHT), Math.max(f(240), stage.height - f(20))) }
    }
    if (request.panel === 'boost' && request.zap) {
      // Eraser: only the editor panel (and the margin of its shadow) is over the window; the rest is the page, which must stay clickable.
      const { shadow, right, width, height } = ZAP_PANEL
      const top = stage.y + f(12)
      // Measured from the window's right edge; with the sidebar at the right, from the card's.
      const edge = this.placement().right ? stage.x + stage.width + f(pageMargin(this.store.get().settings)) : window.width
      return { x: edge - f(right) - f(width) - f(shadow), y: top - f(shadow), width: f(width) + f(shadow) * 2, height: Math.min(f(height), Math.max(f(240), window.height - top - f(22))) + f(shadow) * 2 }
    }
    if (request.panel === 'splitdrop') return stage
    if (request.panel === 'tabcycle') {
      // The panel is centred in the window (x 555 → 1124, y 350 → 538 in 1680 x 888); its shadow needs the margin around it. Laid out in
      // the CSS pixels of the zoomed layer, then scaled to points.
      const css = this.toCss({ x: 0, y: 0, width: window.width, height: window.height })
      const width = cyclePanelWidth(request.cards.length, css.width)
      return this.fromCss({
        x: Math.round((css.width - width) / 2) - CYCLE_PANEL.shadow,
        y: Math.round((css.height - CYCLE_PANEL.height) / 2) - CYCLE_PANEL.shadow,
        width: width + CYCLE_PANEL.shadow * 2,
        height: CYCLE_PANEL.height + CYCLE_PANEL.shadow * 2
      })
    }
    if (request.panel === 'permission') {
      // The bubble under the toolbar: the layer starts at the top edge of the page card and is centred on it; it holds the bubble and the margin of its shadow.
      return {
        x: stage.x + Math.round((stage.width - f(PERMISSION_LAYER.width)) / 2),
        y: stage.y,
        width: f(PERMISSION_LAYER.width),
        height: Math.min(f(PERMISSION_LAYER.height), stage.height)
      }
    }
    // Command bar, downloads, space editor, Tweak editor and Glance are modal: they cover the window.
    return { x: 0, y: 0, width: window.width, height: window.height }
  }

  /**
   * The system's traffic lights follow the sidebar: with it, at their usual place; hidden along with it (none show while the sidebar
   * is hidden, the toolbar's own sidebar button takes their place); with the floating copy, inset with its panel.
   */
  private syncTrafficLights(): void {
    const lights = this.trafficLights()
    // Each call lays the title bar out again, and the layout runs at every change of the state: the lights are given only when they change.
    const key = `${lights.visible} ${lights.position.x} ${lights.position.y}`
    if (key === this.trafficLightsGiven) return
    if (currentPlatform().syncTrafficLights(this.win, lights)) this.trafficLightsGiven = key
  }

  /**
   * The system's buttons over the right end of the window (Windows) follow what is behind them: the ink of their symbols reads on the bar of the page on
   * screen, on a split view's dark strips, or on the space itself when the toolbar is hidden or the sidebar is at the right (they are over it), and their
   * height covers the toolbar's row and the border above it. Told to the window only when it changes: the layout runs at every change of the state.
   */
  private syncControlsOverlay(): void {
    const platform = currentPlatform()
    if (!platform.facts.controlsOverlay) return
    const state = this.store.get()
    const active = activeTab(state)
    const space = state.spaces.find((s) => s.id === (active?.spaceId ?? state.activeSpaceId))
    // With the sidebar shown at the right the buttons are over its first row, on the space itself, not over the toolbar of the page card.
    const { right, docked } = this.placement()
    const overSidebar = right && state.settings.sidebarVisible && !docked
    const overlay = controlsOverlay({
      kind: 'browser',
      margin: pageMargin(state.settings),
      scale: this.k(),
      toolbar: state.settings.showToolbar && !overSidebar,
      split: !!active && !!splitFor(state, active.id),
      pageColor: active ? this.runtime.tabs[active.id]?.color : undefined,
      appearance: space ? resolveAppearance(space.theme, this.systemDark) : 'dark',
      privateBar: this.isPrivate()
    })
    const key = `${overlay.symbolColor} ${overlay.height}`
    if (key === this.controlsOverlayGiven) return
    if (platform.syncControlsOverlay(this.win, overlay)) this.controlsOverlayGiven = key
  }

  /**
   * The button ☰ of the toolbar: the menu of the application, popped up where the interface says (CSS pixels of the window, read again here: a point outside the
   * window opens nothing). Answers whether a menu opened.
   */
  popupAppMenu(anchor: unknown): boolean {
    if (this.win.isDestroyed()) return false
    const bounds = this.win.getContentBounds()
    const at = appMenuAnchor(anchor, this.toCss({ x: 0, y: 0, width: bounds.width, height: bounds.height }))
    if (!at) return false
    const point = this.fromCss({ x: at.x, y: at.y, width: 0, height: 0 })
    return popupApplicationMenu(Menu.getApplicationMenu(), this.win, { x: Math.round(point.x), y: Math.round(point.y) })
  }

  /**
   * Puts these views on top of the window's, in this order, unless they already are: `addChildView` reorders the native views even when nothing
   * moves, and the layout runs at every change of the state. A view added since (a page shown, a cover) is above them, and they go back on top.
   */
  private stackOnTop(views: readonly View[]): void {
    const children = this.win.contentView.children
    const tail = children.slice(Math.max(0, children.length - views.length))
    if (tail.length === views.length && tail.every((child, index) => child === views[index])) return
    for (const view of views) this.win.contentView.addChildView(view)
  }

  /** Where the traffic lights are meant to be and whether they show (the engine test reads it: Electron has no getter). */
  trafficLights(): { visible: boolean; position: { x: number; y: number } } {
    const { sidebarVisible } = this.store.get().settings
    const sidebarRight = this.placement().right
    // The lights keep their size but follow the header of the zoomed sidebar.
    const k = this.k()
    const at = trafficLightsAt({ sidebarVisible, floating: !sidebarVisible && this.floatVisible, sidebarRight })
    return { visible: at.visible, position: { x: scaled(at.position.x, k), y: scaled(at.position.y, k) } }
  }

  /** Z-order, bottom to top: chrome UI, pages, floating sidebar, overlay panel, notice over a page in full screen, Glance page. */
  protected layout(): void {
    const state = this.store.get()
    const settings = state.settings
    this.sidebarTrace.placement(this.sidebarFacts())
    this.syncUiZoom()
    const k = this.k()
    const frame = this.frame()
    const stage = frame.stage
    const active = activeTab(state)
    const split = active ? splitFor(state, active.id) : undefined
    // A page in HTML full screen fills the window, above everything else (the sidebar, the docked panel and the floating sidebar stay under it or away).
    const fullscreenPage = this.fullscreenTab !== null ? this.pages.get(this.fullscreenTab) : undefined
    if (fullscreenPage) {
      const content = this.win.getContentBounds()
      fullscreenPage.show({ x: 0, y: 0, width: content.width, height: content.height }, 0)
      fullscreenPage.raise()
    } else if (split && this.overlayRequest?.panel === 'splitdrop' && this.overlayRequest.split?.full === false) {
      // The veil of a tab that would join the split view draws a picture of each pane where it was: the pages are put away until the drag ends.
      // (Over a full split view the veil only says that it takes no more: its pages stay.)
      for (const id of split.tabIds) this.pages.get(id)?.hide()
    } else if (split) {
      // Worked out in CSS pixels (the gaps, strips and rings are measured there, and the interface draws them the same way), then put in points.
      // The bar of a split view of two panes takes its strip off the foot of the stage: no page goes under it.
      const panes = splitLayout(splitPaneStage(this.toCss(stage), split), split, undefined, TOOLBAR_BAR_HEIGHT)
      split.tabIds.forEach((id, i) => {
        // The focused pane's page leaves room for its ring (drawn by the UI, under the page view, on the pane's own edge).
        const page = this.fromCss(paneContent(panes[i]!, id === active?.id))
        this.pages.get(id)?.show({ x: stage.x + page.x, y: stage.y + page.y, width: page.width, height: page.height }, scaled(pageRadius(id === active?.id), k))
      })
    } else if (this.overlayRequest?.panel === 'splitdrop') {
      // The veil draws a picture of the page where the page was: the page itself is put away until the drag ends.
      this.activePage()?.hide()
    } else {
      this.activePage()?.show(stage)
    }

    const docked = this.sidePanel?.page ?? this.webPanel?.page
    if (docked && frame.panel && !fullscreenPage) docked.show(frame.panel)

    // Showing the real sidebar ends the floating one: it must not come back by itself the next time the sidebar is hidden.
    if (settings.sidebarVisible && this.floatVisible) {
      if (this.floatTimer) clearTimeout(this.floatTimer)
      this.floatTimer = null
      this.floatVisible = false
      this.floatPhase = null
    }
    this.syncTrafficLights()
    this.syncControlsOverlay()
    // The view of the floating sidebar lives while the sidebar is hidden, loaded before the pointer reaches the edge; it goes a few minutes after the sidebar is back.
    this.floating.want(!settings.sidebarVisible)
    const floatingView = this.floating.current()
    // Bottom to top over the pages: the floating sidebar, then the layer of panels.
    const onTop: View[] = []
    if (!settings.sidebarVisible && this.floatVisible && !fullscreenPage) {
      const view = this.floating.ensure()
      // The panel (inset FLOATING_INSET from the edges) and the transparent margin its shadow needs.
      const window = this.win.getContentBounds()
      const right = this.placement().right
      const box = floatingBox({ width: window.width, height: window.height, sidebarWidth: settings.sidebarWidth, sidebarRight: right })
      const w = scaled(box.width, k)
      view.setBounds({ ...box, x: right ? window.width - w : 0, width: w })
      onTop.push(view)
    } else if (floatingView && this.win.contentView.children.includes(floatingView)) {
      this.win.contentView.removeChildView(floatingView)
    }

    if (this.overlayRequest) {
      if (this.overlayRequest.panel === 'peek') this.overlayRequest = { panel: 'peek', rect: this.toCss(this.peekRect()), stage: this.toCss(stage) }
      this.overlay.setBounds(this.overlayBounds(this.overlayRequest))
      onTop.push(this.overlay)
    }
    // Above everything, the page in full screen included: what the page draws cannot cover it, and it never takes the keyboard from the page.
    const notice = this.fullscreenNotice.follow(fullscreenPage ? this.fullscreenTab : null, state.tabs.find((t) => t.id === this.fullscreenTab)?.url, this.win.getContentBounds())
    if (notice) {
      notice.view.setBounds(notice.bounds)
      onTop.push(notice.view)
    }
    this.stackOnTop(onTop)

    if (this.peek && this.overlayRequest?.panel === 'peek') {
      // Inside the 2 px edge the card has in the colour of the space, under its 40 px header; the corners follow the edge's inner curve.
      this.peek.page.show(peekPageRect(this.peekRect(), scaled(PEEK_HEADER_HEIGHT, k), scaled(PEEK_BORDER, k)), scaled(PEEK_PAGE_RADIUS, k))
      // Above the overlay's dimmed backdrop, so the preview is neither dimmed nor click-through.
      this.peek.page.raise()
    }
  }
}
