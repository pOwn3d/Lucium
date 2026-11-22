// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The overlay (command bar, panels), the address
// submitted, the switcher of ⌃Tab and the drag of a split view.

import { nativeImage, screen } from 'electron'
import { Channel, type CommandBarMode, type OverlayRequest } from '@shared/ipc'
import { PROMPT_CANCELLED } from '@shared/page-dialog'
import { instantLinkUrls, knownOnlyPrivately } from '@shared/command-bar'
import { activeProfileId, profileSearch } from '@shared/profiles'
import { canOpenInPrivate } from '@shared/private-window'
import { visibleTabIds } from '@shared/window-selection'
import { canOpenWhileLocked, editsLockedSpace } from '@shared/lock'
import { planDrop, veilFor, type DropHost, type SplitDropZone, type Veil } from '@shared/split-drop'
import { gridPictures } from '@shared/tab-grid'
import { firstSelection, stepSelection, visibleRecentCards, type CycleKey } from '@shared/tab-cycle'
import { heldModifiers, physicalKey } from '@shared/keybindings'
import { activeTab, splitFor, splitIsFull, tabOpenedSince } from '@shared/sidebar'
import { isNavigableUrl, resolveInput } from '@shared/url'
import { extensionsPageOf } from '@shared/settings-target'
import { chromePageOf } from '@shared/chrome-pages'
import type { ThumbnailSource } from './thumbnails'
import { getLockService } from '../lock-service'
import { getImportService } from '../importers/service'
import { arcGuideRequest } from '@shared/arc-guide'
import { t } from '@shared/i18n'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { panelIsScaled, screenOf } from '@shared/panel-scale'
import { isFindPanel, SPLIT_DRAG_GRACE_MS, VEIL_JPEG_QUALITY } from './browser-base'
import { ScreenWatch, SETTLE_DELAY_MS, SHOWN_DELAY_MS } from './screen-notice'
import { BrowserSite } from './browser-site'

export abstract class BrowserOverlay extends BrowserSite {
  /**
   * The window follows the screen it is on. When it is moved to another one (looked at once the move has rested), the panel that is open takes the factor of
   * that screen. In a normal window, the notice about the size of the panels is offered once per very wide or very small screen: a moment after the window
   * is shown, when it takes the focus, and after a move. Not in a private window (its settings are not kept, so « once » would be every time) nor in the
   * engine test (a notice must not come in the way of what it checks).
   */
  protected watchScreen(): void {
    if (!this.isPrivate() && !process.argv.includes('--smoke')) {
      this.screenWatch = new ScreenWatch({
        screen: () => screenOf(screen.getDisplayMatching(this.win.getBounds())),
        sizes: () => this.store.get().settings.panelSizes,
        busy: () => this.overlayRequest !== null || getLockService()?.isAppLocked() === true || !this.win.isVisible() || this.win.isMinimized(),
        show: (kind, info) => {
          // Remembered first: whatever happens to the notice, it is not offered twice.
          this.dispatch({ type: 'panel-size/noticed', screen: info })
          this.showToast(t(kind === 'wide' ? 'panel-size.notice-petits' : 'panel-size.notice-grands'), { label: t('panel-size.regler'), run: () => this.openOverlay({ panel: 'settings', pane: 'appearance', anchor: 'panelsize' }) })
        },
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout)
      })
      this.win.once('show', () => this.screenWatch?.soon(SHOWN_DELAY_MS))
      this.win.on('focus', () => this.screenWatch?.soon())
    }
    this.win.on('move', () => {
      if (this.screenMoveTimer) clearTimeout(this.screenMoveTimer)
      this.screenMoveTimer = setTimeout(() => {
        this.screenMoveTimer = null
        if (this.win.isDestroyed()) return
        if (this.overlayRequest !== null && panelIsScaled(this.overlayRequest)) this.layout()
        this.screenWatch?.soon(0)
      }, SETTLE_DELAY_MS)
    })
  }

  /** The window is closed: nothing is left waiting. */
  protected stopWatchingScreen(): void {
    if (this.screenMoveTimer) clearTimeout(this.screenMoveTimer)
    this.screenMoveTimer = null
    this.screenWatch?.stop()
  }

  /** `request` for the panel of the site with the strip of the focused pane of a split view as its anchor (CSS pixels of the interface), or as it was when the tab is in none. */
  private withPaneAnchor(request: OverlayRequest): OverlayRequest {
    const state = this.store.get()
    const active = activeTab(state)
    const split = active ? splitFor(state, active.id) : undefined
    const index = split && active ? split.tabIds.indexOf(active.id) : -1
    if (!split || split.tabIds.length < 2 || index < 0) return request
    const stage = this.stageRect()
    const pane = this.splitPanes(stage, split)[index]
    if (!pane) return request
    const strip = this.toCss({ x: stage.x + pane.x, y: stage.y + pane.y, width: pane.width, height: pane.height })
    return { panel: 'site', anchor: { x: strip.x, y: strip.y, width: strip.width, height: strip.height } }
  }

  openOverlay(request: OverlayRequest): void {
    this.tooltipWindow.hide()
    // "New Mini Window" asks for the bar in `little` mode: it shows in a window of its own, not over this one.
    if (request.panel === 'commandbar' && request.mode === 'little' && this.littleBarOpener) return this.littleBarOpener(this.windowBounds())
    // The editor asking to leave the Eraser mode: the page's picker ends first, and `startZap` reopens the editor once the picks are saved.
    if (this.zapping && request.panel === 'boost' && !request.zap) return this.endZap()
    if (this.isPrivate() && !canOpenInPrivate(request.panel)) return
    // Over the lock screen nothing opens: the command bar of a window made while the application is locked (the Dock's New Window) would hide the field of the phrase.
    if (!canOpenWhileLocked(request.panel, getLockService()?.isAppLocked() === true)) return
    // The editor of a locked space would only collect changes that are refused: the notice says why it does not open.
    if (editsLockedSpace(request, getLockService()?.lockedSpaces() ?? [])) return this.showToast(t('lock.deverrouillez-l-espace-d-abord'))
    // A page is blocked on this box: nothing else takes its place (a shortcut that opens a panel does nothing until the user has answered).
    if (this.overlayRequest?.panel === 'dialog' && request.panel !== 'dialog') return
    // A web tool that is switched off opens nothing, whoever asks (the menu hides its entries; this is the switch itself).
    if (request.panel === 'qr' && !this.store.get().settings.qrCode) return
    if (request.panel === 'translate' && !this.store.get().settings.translateLocal) return
    if (request.panel === 'passwords' && !this.store.get().settings.passwordManager) return
    // The "Onglets" mode of the command bar (⌘⇧A) and the sheet of the shortcuts (⌘/) are functions of their own: off, whoever asks, nothing opens.
    if (request.panel === 'commandbar' && request.mode === 'tabs' && !this.store.get().settings.tabSearch) return
    // A split view of four panes takes no more: the bar would open a tab of its own instead. The shortcut says so; the menus grey the entry out.
    if (request.panel === 'commandbar' && request.mode === 'split' && splitIsFull(this.store.get())) return this.showToast(t('split-drop.quatre-volets-au-plus'))
    if (request.panel === 'shortcuts' && !this.store.get().settings.shortcutHelp) return
    // The tab overview is a function of its own. The pictures are taken here, from the ones the hover cards keep: whatever the request carries is dropped.
    if (request.panel === 'tabgrid') {
      if (!this.store.get().settings.tabGrid) return
      const source = this.thumbnailSource
      request = { panel: 'tabgrid', pictures: gridPictures(this.store.get(), (tabId) => source?.get(tabId) ?? null, this.isPrivate()) }
    }
    if (request.panel === 'bookmarks' && !this.store.get().settings.bookmarkManager) return
    if (request.panel === 'livefolder' && !this.store.get().settings.liveFolders) return
    if (request.panel === 'notes' && !this.store.get().settings.notes) return
    // The sheet of a work view: never while the function is off (its menu entries are gone then), nor in a private window, which keeps no view.
    if (request.panel === 'workview' && (!this.store.get().settings.workViewsEnabled || this.isPrivate())) return
    // The notices of this window, read again: the list is this window's own, whatever the request carries.
    if (request.panel === 'notices') request = { panel: 'notices', items: this.noticeLog.list() }
    // The panel of the site hangs from the pane of the tab it is about: opened by ⌘I or the menu in a split view, it takes the place the button of that pane gives it.
    if (request.panel === 'site' && request.anchor === undefined) request = this.withPaneAnchor(request)
    if (request.panel === 'settings') return this.settingsOpener?.(request.pane, request.anchor)
    if (request.panel === 'extensions') return this.openExtensionsTab(request.target)
    // Whatever replaces the panel of ⌃Tab ends it; a split view waiting for the command bar is forgotten when another panel opens.
    if (request.panel !== 'tabcycle') this.dropCycle()
    if (request.panel !== 'commandbar') this.pendingSplit = null
    // A search is for the page the user is in: in a split view, the pane that has the keyboard is selected before the bar takes it (see `followPaneFocus`).
    if (isFindPanel(request.panel)) this.followPaneFocus()
    // Find and Find and Replace are the same search: moving from one to the other keeps it, leaving both ends it.
    if (isFindPanel(this.overlayRequest?.panel) && !isFindPanel(request.panel)) this.endFind()
    if (this.overlayRequest?.panel === 'peek' && request.panel !== 'peek') this.destroyPeek()
    if (this.overlayRequest?.panel === 'annotate' && request.panel !== 'annotate') this.dropCapture(this.overlayRequest.id)
    this.setAsideQuestion(request)
    const wasPlus = this.overlayRequest?.panel === 'plus'
    // Seen once, from wherever it was opened: it then no longer opens by itself after an import (shared/arc-guide.ts).
    if (request.panel === 'arcguide' && !this.store.get().settings.arcGuideSeen) this.dispatch({ type: 'settings/update', patch: { arcGuideSeen: true } })
    this.overlayRequest = request
    if (request.panel === 'permission') this.permissionShown = { id: request.request.id, at: Date.now() }
    // Chromium keeps one zoom for a page address, and the layer of every window is the same page: another window that showed a panel of its own factor
    // since this one did has changed it under this one. The zoom is read again, whatever this window last gave it.
    this.layerZoom = null
    this.layout()
    // A view put back in the window after it was taken out is shown again without waiting for the focus (the veil and the panel of ⌃Tab are
    // drawn before anything has focused the layer, and a layer that stays hidden does not draw).
    this.overlay.setVisible(true)
    // A permission prompt must not steal the focus from the page the user is working in. The panel of ⌃Tab takes it: the page would never hear
    // ⌃ go up (see `cycleKeyFromPanel`). The veil of a drag takes it too: in the engine test a layer put back in the window without being
    // focused did not draw (the first draw after it was taken out), and the drag itself belongs to the operating system, not to the focus.
    if (request.panel !== 'permission') this.overlay.webContents.focus()
    // The panel is shown over the state it was asked with: what was published before it reaches the layer first, as it did, and so does the
    // state published while the layer was closed (it is not sent to a closed layer, see `publishHere`).
    this.publishQueue.flush()
    this.sendMissedSnapshot()
    this.overlay.webContents.send(Channel.showOverlay, request)
    // The + of the sidebar turns into a cross while its popover is open.
    if (wasPlus || request.panel === 'plus') this.publish()
  }

  /**
   * Another panel takes the place of a question the user has not answered (a shortcut opened the command bar over a permission, a menu opened a
   * sheet over a login a server asks for). The question is not dropped: whoever asked would wait for good, and a page whose login is left
   * without an answer asks nothing else. It goes back to the head of its line and shows again when the panel closes. « Quitter ce site ? » has
   * no line: it is answered as staying, the navigation can be asked again.
   */
  private setAsideQuestion(next: OverlayRequest): void {
    const shown = this.overlayRequest
    if (!shown || shown === next) return
    if (shown.panel === 'permission' && this.permissionAnswers.has(shown.request.id)) this.permissionQueue.unshift(shown.request)
    else if (shown.panel === 'auth' && this.authAnswers.has(shown.request.id)) this.authQueue.unshift(shown.request)
    else if (shown.panel === 'extreview' && this.reviewAnswers.has(shown.request.id)) this.reviewQueue.unshift(shown.request)
    else if (shown.panel === 'passphrase' && this.passphraseAnswers.has(shown.request.id)) this.passphraseQueue.unshift(shown.request)
    else if (shown.panel === 'leave') this.answerLeave(shown.request.id, false, true)
  }

  closeOverlay(): void {
    const closing = this.overlayRequest
    if (!closing) return
    if (isFindPanel(closing.panel)) this.endFind()
    if (closing.panel === 'peek') this.destroyPeek()
    // Dismissing a prompt without answering is a refusal, not a pending request.
    if (closing.panel === 'permission') this.answerPermission(closing.request.id, false, false, true)
    if (closing.panel === 'auth') this.answerAuth(closing.request.id, null, true)
    if (closing.panel === 'dialog') this.answerDialog(closing.request.id, PROMPT_CANCELLED, true)
    // Dismissing "Quitter ce site ?" without answering is staying.
    if (closing.panel === 'leave') this.answerLeave(closing.request.id, false, true)
    if (closing.panel === 'extreview') this.answerExtensionReview(closing.request.id, false, true)
    if (closing.panel === 'passphrase') this.answerPassphrase(closing.request.id, null, true)
    // Closing the editor while erasing puts the page back as it was (the picks so far are kept).
    if (closing.panel === 'boost' && this.zapping) this.endZap()
    // The sheet that was showing a capture goes with it: leaving it unsaved is giving it up.
    if (closing.panel === 'annotate') this.dropCapture(closing.id)
    this.overlayRequest = null
    // The layer is told that its panel is closed, and unmounts it: what the panel held (a password typed, a capture, a list) is let go, its
    // listeners and timers end, and a deletion that was waiting to be taken back is made now. Without this the panel stayed mounted, out of
    // sight, until the next one opened, and that next one could be drawn for an instant over the old content.
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.send(Channel.showOverlay, null)
    this.win.contentView.removeChildView(this.overlay)
    if (closing.panel === 'tabcycle') this.dropCycle()
    // The page was put away for the veil: it comes back where it was.
    if (closing.panel === 'splitdrop') this.layout()
    // A split view that was waiting for its other page is given up with the command bar (Escape: one page, no tab added).
    if (closing.panel === 'commandbar') this.pendingSplit = null
    if (closing.panel === 'plus') this.publish()
    // The questions in line whose tab is no longer on screen wait for it instead (browser-dialogs.ts, `whenOnScreen`).
    this.parkOffScreenQuestions()
    const next = this.permissionQueue.shift()
    const nextAuth = next ? undefined : this.authQueue.shift()
    const nextDialog = next || nextAuth ? undefined : this.dialogQueue.shift()
    const nextReview = next || nextAuth || nextDialog ? undefined : this.reviewQueue.shift()
    // Taken from its line only when it is the one shown: taken while a box or a review goes first, it was lost and its question never answered.
    const nextPassphrase = next || nextAuth || nextDialog || nextReview ? undefined : this.passphraseQueue.shift()
    if (next) this.openOverlay({ panel: 'permission', request: next })
    else if (nextAuth) this.openOverlay({ panel: 'auth', request: nextAuth })
    // Not in this call: the code that closed the panel may be about to use the active tab (the command bar loads its address there), and showing the box selects the tab that asks.
    else if (nextDialog) queueMicrotask(() => this.showDialog(nextDialog))
    else if (nextReview) this.openOverlay({ panel: 'extreview', request: nextReview })
    else if (nextPassphrase) this.openOverlay({ panel: 'passphrase', request: nextPassphrase })
    else if (!this.openArcGuideAfterImport(closing.panel)) this.activePage()?.focus()
  }

  /**
   * The sheet that ran an import (the import sheet, the first-launch guide) was left: if the import came from Arc and its guide was not seen, it opens now, with what
   * the import brought. Whatever the way out (the button, Escape, a click outside). What the service took is forgotten, so a second import sheet closed
   * without an import of its own opens nothing. Answers whether the guide opened.
   */
  private openArcGuideAfterImport(closing: OverlayRequest['panel']): boolean {
    if (closing !== 'import' && closing !== 'firstlaunch') return false
    const request = arcGuideRequest(getImportService()?.takeArcGuide() ?? null, this.store.get().settings)
    if (!request) return false
    this.openOverlay(request)
    return true
  }

  currentPanel(): OverlayRequest['panel'] | null {
    return this.overlayRequest?.panel ?? null
  }

  currentOverlay(): OverlayRequest | null {
    return this.overlayRequest
  }

  /** The search engine of a profile (each profile keeps its own). */
  protected searchTemplateFor(profileId: string): string {
    return profileSearch(this.store.get().settings, profileId).url
  }

  submitUrl(input: string, mode: CommandBarMode, instant = false): void {
    if (instant) {
      // ⇧↩: the first result of each search. Only web addresses come out of it, so the renderer can ask freely.
      const urls = instantLinkUrls(input, this.searchTemplateFor(activeProfileId(this.store.get())))
      this.closeOverlay()
      urls.forEach((url, i) => this.dispatch({ type: 'tab/open', url, background: i > 0 }))
      return
    }
    // `chrome://extensions` is no web address: the extensions have a page of their own (the bar sends the text as typed when nothing in the list was picked).
    const extensionsPage = extensionsPageOf(input)
    if (extensionsPage) {
      this.closeOverlay()
      return this.openExtensionsTab(extensionsPage)
    }
    // `chrome://history`, `arc://settings/privacy`…: the page of Lucium that stands for the address, or a notice that there is none (never a web search for that text).
    const chromePage = chromePageOf(input, { private: this.isPrivate(), settings: this.store.get().settings })
    if (chromePage) {
      this.closeOverlay()
      if (chromePage.request) this.openOverlay(chromePage.request)
      if (chromePage.notice) this.showToast(chromePage.notice, undefined, ACTION_NOTICE_MS)
      return
    }
    // The renderer is not trusted: resolve again here so only web URLs or searches get through.
    const resolved = resolveInput(input, this.searchTemplateFor(activeProfileId(this.store.get())))
    // Closing the bar gives up the split view it was opened for: what it was for is read first.
    const pending = mode === 'split' ? this.pendingSplit : null
    this.closeOverlay()
    if (!resolved) return
    // An address typed with its scheme that cannot be read (`http://exa mple.com`): the page would refuse it by throwing, the user is told instead.
    if (!isNavigableUrl(resolved.url)) return this.showToast(t('browser.adresse-invalide'))
    const page = this.activePage()
    // The page of a private tab asked for in another place (⌘↩ on its line, a mini window, a split view): it stays private. An ordinary tab or a
    // mini window would write its address in the saved state and the history.
    const privately = knownOnlyPrivately(this.store.get(), resolved.url)
    if (mode === 'little' && !privately) return this.littleOpener?.(resolved.url, { spaceId: this.store.get().activeSpaceId, from: this.windowBounds() })
    if (mode === 'current' && page) return page.loadURL(resolved.url)
    const beside = mode === 'split' ? activeTab(this.store.get()) : undefined
    const before = this.store.get()
    this.dispatch({ type: 'tab/open', url: resolved.url, ...(privately ? { private: true } : {}) })
    // A split view pairs the tab that was open with the one just made. When the opening was refused (an address too long to keep), there is no
    // such tab: nothing is paired, rather than the last tab of the state, which has nothing to do with what was typed.
    const opened = tabOpenedSince(before, this.store.get())
    if (beside && opened) {
      // A tab dragged onto itself: the new page takes the side the box was not on, and is the one shown.
      if (pending && pending.tab === beside.id) {
        const before = pending.newTab === 'before'
        this.dispatch({ type: 'split/create', tabId: before ? opened.id : beside.id, withTabId: before ? beside.id : opened.id, orientation: pending.orientation, focus: before ? 'first' : 'second' })
      } else this.dispatch({ type: 'split/create', tabId: beside.id, withTabId: opened.id })
    }
  }

  // ---- ⌃Tab: the tabs in the order they were used, with a panel of pictures while ⌃ is held (rules: shared/tab-cycle.ts) ----

  /** Where the pictures of the tabs come from (the hover card's). */
  setThumbnailSource(source: ThumbnailSource | null): void {
    this.thumbnailSource = source
  }

  /** The panel on screen, for the engine test. */
  currentCycle(): { index: number; ids: string[] } | null {
    return this.cycle ? { index: this.cycle.index, ids: this.cycle.cards.map((c) => c.id) } : null
  }

  /** Whether this window is listening to keys for ⌃Tab (the engine test checks that the setting really switches it off). */
  isWatchingTabKeys(): boolean {
    return this.cycleWatching
  }

  /**
   * Starts or stops listening to the keys of the pages and of the interface, as the setting asks. Nothing is listened to when it is off, and
   * the record of when each tab was left is only kept while it is on.
   */
  protected syncCycleWatch(): void {
    const want = this.store.get().settings.tabCycleRecent
    if (want === this.cycleWatching) return
    this.cycleWatching = want
    for (const page of this.pages.values()) page.watchKeys(want ? this.cycleKey : null)
    if (want) this.win.webContents.on('before-input-event', this.interfaceKey)
    else {
      this.win.webContents.off('before-input-event', this.interfaceKey)
      this.endCycle(false)
      this.usedAt.clear()
    }
  }

  /**
   * A key press the panel of ⌃Tab saw. The panel has the keyboard while it is up: Chromium does not tell the shell of any key that goes up
   * after a key the shell took (the Tab that opened the panel), so the release of ⌃ could not be heard in the page.
   */
  cycleKeyFromPanel(key: CycleKey): void {
    if (this.cycle) this.cycleKey({ ...key, code: physicalKey(key) })
  }

  protected startCycle(direction: 1 | -1, accelerator: string): boolean {
    const state = this.store.get()
    // A tab lives in one window at a time: the ones another window shows are not this window's to go to.
    const elsewhere = new Set([...this.group].filter((b) => b !== this).flatMap((b) => visibleTabIds(b.store.get())))
    const source = this.thumbnailSource
    // Over the lock screen the panel would show the titles and pictures of what the lock hides: it is made from the state the interface is given.
    const cards = visibleRecentCards(state, getLockService()?.view(), { exclude: elsewhere, usedAt: this.usedAt, ...(source ? { thumb: (tabId: string) => source.get(tabId) } : {}) })
    const index = firstSelection(cards.length, direction)
    // One tab (or none): there is nowhere to go, and the key is spent all the same.
    if (index === null) return true
    const hold = heldModifiers(accelerator)
    // A shortcut with nothing to hold (a user's own, F-key) has no panel to keep: it just goes.
    if (hold.length === 0) {
      this.dispatch({ type: 'tab/select', id: cards[index]!.id })
      return true
    }
    this.openOverlay({ panel: 'tabcycle', cards, index })
    if (this.currentPanel() !== 'tabcycle') return true
    this.cycle = { cards, index, hold }
    // The window loses the focus with ⌃ still down (⌘Tab to another application): its release will never be heard here.
    this.cycleBlur = () => this.endCycle(false)
    this.win.once('blur', this.cycleBlur)
    return true
  }

  protected stepCycle(direction: 1 | -1): boolean {
    const cycle = this.cycle
    if (!cycle) return false
    cycle.index = stepSelection(cycle.index, cycle.cards.length, direction)
    this.publishQueue.flush()
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.send(Channel.cycleIndex, cycle.index)
    return true
  }

  /** The panel goes. With `commit`, the tab it was on is shown (a tab closed meanwhile is not). */
  protected endCycle(commit: boolean): void {
    const cycle = this.cycle
    if (!cycle) return
    this.dropCycle()
    if (this.overlayRequest?.panel === 'tabcycle') this.closeOverlay()
    const card = cycle.cards[cycle.index]
    if (commit && card && this.store.get().tabs.some((t) => t.id === card.id)) this.dispatch({ type: 'tab/select', id: card.id })
  }

  /** Forgets the panel without closing anything (what closes it is already doing so). */
  protected dropCycle(): void {
    this.cycle = null
    if (this.cycleBlur) this.win.off('blur', this.cycleBlur)
    this.cycleBlur = null
  }

  // ---- a tab dragged from the sidebar onto the page: the veil shows where a split view would put it (rules: shared/split-drop.ts) ----

  /**
   * A tab row of the sidebar starts to be dragged. If a split view can be made of it and the page on screen, the veil opens over the page:
   * a picture of the page that shrinks beside an empty box as the pointer goes to a side, and a ring in the middle. Over a split view of two or
   * three panes the veil draws a picture of each, and the box opens in the cell the tab would take: at a side, or in a corner, which makes a grid
   * (the panes move to where the grid will have them). Over a split view of four it says that the split
   * view takes no more. Nothing happens with the setting off, with the sidebar hidden, with a panel open, when the tab is already in a split view,
   * or when it is in another space.
   */
  beginSplitDrag(tabId: string): void {
    // A drag that ended a moment ago and is still waiting for its drop gives way to this one.
    if (this.splitDrag) this.closeSplitDrag()
    const veil = veilFor(this.store.get(), tabId, { overlayOpen: this.overlayRequest !== null, hasPage: this.activePage() !== undefined })
    if (!veil) return
    const token = ++this.splitDragCounter
    this.splitDrag = { tabId, token }
    void this.openSplitVeil(token, tabId, veil)
  }

  /** A picture of a page for the veil (a `data:` URL), or null: the veil then draws a plain card, the split view does not depend on the picture. */
  private async veilPicture(take: () => Promise<Buffer | null>, what: string): Promise<string | null> {
    try {
      const png = await take()
      const image = png ? nativeImage.createFromBuffer(png) : null
      return image && !image.isEmpty() ? `data:image/jpeg;base64,${image.toJPEG(VEIL_JPEG_QUALITY).toString('base64')}` : null
    } catch (error) {
      console.warn(`[split-drag] no picture of ${what}:`, (error as Error).message)
      return null
    }
  }

  private async openSplitVeil(token: number, tabId: string, veil: Veil): Promise<void> {
    let snapshot: string | null = null
    let split: DropHost | undefined
    if (veil.kind === 'page') snapshot = await this.veilPicture(() => this.capture(false), `the page for the veil of tab ${tabId}`)
    else {
      // A full split view keeps its pages on screen under the veil, which only says that it takes no more: no picture is taken.
      const full = veil.kind === 'full'
      const snapshots = full
        ? []
        : await Promise.all(veil.split.tabIds.map((id) => this.veilPicture(async () => (await this.pages.get(id)?.capture(false)) ?? null, `the pane ${id} for the veil of tab ${tabId}`)))
      const grid = veil.split.grid
      split = { orientation: veil.split.orientation, ratios: [...veil.split.ratios], ...(grid ? { grid: { ...grid } } : {}), snapshots, full }
    }
    // The drag may have ended, or a panel opened, while the pictures were taken.
    if (this.splitDrag?.token !== token || this.overlayRequest) return
    // The layer is zoomed with the interface: the veil is drawn in its CSS pixels.
    const stage = this.toCss(this.stageRect())
    this.openOverlay({ panel: 'splitdrop', tabId, size: { width: stage.width, height: stage.height }, snapshot, sidebarRight: this.placement().right, ...(split ? { split } : {}) })
  }

  /** The drag of the tab ended (dropped anywhere, or cancelled). The veil waits a moment for a drop that may still be on its way. */
  endSplitDrag(): void {
    const drag = this.splitDrag
    if (!drag || drag.endTimer) return
    drag.endTimer = setTimeout(() => {
      if (this.splitDrag === drag) this.closeSplitDrag()
    }, SPLIT_DRAG_GRACE_MS)
    drag.endTimer.unref()
  }

  private closeSplitDrag(): void {
    const drag = this.splitDrag
    if (!drag) return
    if (drag.endTimer) clearTimeout(drag.endTimer)
    this.splitDrag = null
    if (this.overlayRequest?.panel === 'splitdrop') this.closeOverlay()
  }

  /** The tab was dropped on `zone` of the veil: a split view is made or joined (or, for the ring, nothing), and the veil goes. */
  dropOnPage(zone: SplitDropZone): void {
    const drag = this.splitDrag
    if (!drag || this.overlayRequest?.panel !== 'splitdrop') return
    this.closeSplitDrag()
    const state = this.store.get()
    const current = activeTab(state)
    if (!current || !state.tabs.some((t) => t.id === drag.tabId)) return
    const plan = planDrop(zone, drag.tabId, current.id, splitFor(state, current.id))
    if (!plan) return
    if (plan.kind === 'join') {
      // The dragged tab is the new pane, in the cell the box was (a side or a corner), and the one shown.
      this.dispatch({ type: 'split/create', tabId: plan.tab, withTabId: plan.with, zone: plan.zone })
      return
    }
    if (plan.kind === 'pair') {
      this.dispatch({ type: 'split/create', tabId: plan.first, withTabId: plan.second, orientation: plan.orientation, focus: plan.focus })
      return
    }
    // The tab on screen was the one dragged: the other pane is a new tab, whose page the command bar asks for. Escape leaves one page.
    this.openOverlay({ panel: 'commandbar', mode: 'split', initial: '' })
    if (this.currentPanel() === 'commandbar') this.pendingSplit = plan
  }
}
