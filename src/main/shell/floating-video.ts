// Lucium's floating video window: « Image dans l'image » asked from Lucium (Fichier › Image dans l'image, the button of the media player) moves
// the live view of the tab into a small window without a frame that stays above the others (Page.lendView: nothing loads again, nothing is
// captured), brings the video to fill it where it is (engine/floating-video-scripts.ts), and lays a bar of controls over it (src/renderer/
// floating-video.tsx). One video floats at a time, for the whole group of windows. « Revenir à l'onglet » and the close button give the view back
// to its tab, which is shown, selected, in its window; so does ⌘W in the floating window. The site's own Picture in Picture button and the automatic picture
// lead here too (Browser.takeSitePictureInPicture, floatWatchedVideo); the system's window is the fallback. What the bar shows and asks: shared/floating-video.ts.

import { ipcMain, type BrowserWindow, type IpcMainEvent, type WebContentsView } from 'electron'
import { Channel } from '@shared/ipc'
import { aspectOf, canSeek, floatingBounds, muteSteps, parseFloatingCommand, FLOATING_WATCH_MS, type FloatingVideoCommand, type FloatingVideoFacts, type FloatingVideoState } from '@shared/floating-video'
import { isMainFrameSender } from '@shared/surface-guard'
import { shutByLock } from './lock-gate'
import type { Rect } from '@shared/window-layout'
import type { Page, ViewLoan } from '../engine/types'

/** The id of the floating window among the windows the engine attaches pages to (index.ts, `windows`). */
export const FLOATING_WINDOW_ID = 'floating-video'

/** What the floating window needs of the window a tab is in (a `Browser`: browser-media.ts, `floatingOwner`). */
export interface FloatingOwner {
  /** The tab is shown in its window, selected (its page comes back there with the layout this brings); `focus` brings the window to the front. */
  showTab(tabId: string, focus: boolean): void
  /** Whether the tab's sound is cut (the speaker of its row), and cutting or giving it back as the row's button does. */
  tabMuted(tabId: string): boolean
  setTabMuted(tabId: string, muted: boolean): void
  /** The tab floats, or no longer does: its row shows it, the place of its page says so, and its window lays its page out again. */
  floatingChanged(tabId: string, floating: boolean): void
  /** The site of the tab (its host), shown at the top of the window. */
  siteOf(tabId: string): string
  /** Where the tab's window is: the floating window opens on its screen. */
  windowBounds(): Rect | null
}

export interface FloatingVideoDeps {
  /** Makes the window (not shown), at `bounds`: no frame, above the other windows, its own content black. */
  createWindow(bounds: Rect): BrowserWindow
  /** Makes the view of the bar (transparent, the interface's preload) and loads it. */
  createBar(): WebContentsView
  /** Windows by id, shared with the engine so that a page can be lent to one. */
  windows: Map<string, BrowserWindow>
  /** Webcontents allowed to call the privileged IPC: the bar is one while it exists. */
  trusted: Set<number>
  /** The work area of the screen the window `near` is on (the main screen for null). */
  workArea(near: Rect | null): Rect
  /** Where the bar's messages are listened to (Electron's ipcMain; a test gives its own). */
  ipc?: { on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown }
}

/** What `float` answers: the video floats, or why not (`frame`: it is in a frame of the page, which the system's own window takes instead). */
export type FloatOutcome = { ok: true } | { ok: false; reason: 'frame' | 'no-video' | 'refused' | 'busy' | 'gone'; detail?: string }

/** How a floating video ends: `back` shows its tab and its window, `close` pauses it and shows its tab, `quiet` only gives the view back. */
type Ending = 'back' | 'close' | 'quiet'

interface Floating {
  tabId: string
  page: Page
  owner: FloatingOwner
  win: BrowserWindow
  bar: WebContentsView
  loan: ViewLoan
  aspect: number
  pinned: boolean
  facts: FloatingVideoFacts | null
  /** The reading of the video while the bar is on screen. */
  watch: ReturnType<typeof setInterval> | null
  over: boolean
}

export class FloatingVideo {
  private current: Floating | null = null
  private starting = false
  /** Where the window was last, and its size: the next one opens there (in this session). */
  private remembered: Rect | null = null

  constructor(private readonly deps: FloatingVideoDeps) {
    ;(deps.ipc ?? ipcMain).on(Channel.floatingVideoAction, (event, raw) => {
      // Only the bar of the window that floats now, through its top frame, drives it.
      if (!isMainFrameSender(event)) return console.warn('[pip] ignored a command of the floating window from a subframe')
      if (shutByLock(Channel.floatingVideoAction)) return
      const floating = this.current
      if (!floating || floating.over || floating.bar.webContents.id !== event.sender.id) return console.warn('[pip] ignored a command for the floating window from another surface')
      const command = parseFloatingCommand(raw)
      if (!command) return console.warn('[pip] ignored a command of the floating window that is not one')
      void this.act(floating, command).catch((error: unknown) => console.error(`[pip] the floating window could not do "${command.kind}":`, error instanceof Error ? error.message : String(error)))
    })
  }

  /** The tab whose video floats, if any. */
  floatingTab(): string | null {
    return this.current && !this.current.over ? this.current.tabId : null
  }

  /** The window that floats now (the engine test reads it). */
  window(): BrowserWindow | null {
    return this.current && !this.current.over ? this.current.win : null
  }

  /**
   * Floats the video of `page`, the page of `tabId` in the window of `owner`. A video in the page itself floats in Lucium's window; one that is only in a
   * frame of the page answers `frame` (the caller floats it in the system's window); a tab that floats already has its window brought to the front.
   * Another video that floats goes back to its tab first, without showing it.
   */
  async float(owner: FloatingOwner, tabId: string, page: Page): Promise<FloatOutcome> {
    if (this.floatingTab() === tabId) {
      this.show()
      return { ok: true }
    }
    if (this.starting) return { ok: false, reason: 'busy' }
    if (!page.lendView || !page.findFloatingVideo || !page.stageFloatingVideo) return { ok: false, reason: 'refused', detail: 'this page cannot be lent' }
    this.starting = true
    try {
      const where = await page.findFloatingVideo()
      if (where !== 'page') return { ok: false, reason: where === 'frame' ? 'frame' : 'no-video' }
      if (this.current) this.end(this.current, 'quiet')
      const stage = await page.stageFloatingVideo()
      if (!stage.staged) return { ok: false, reason: stage.reason === 'gone' ? 'gone' : stage.reason === 'error' ? 'refused' : 'no-video', ...(stage.detail ? { detail: stage.detail } : {}) }
      const aspect = aspectOf(stage.width, stage.height)
      const win = this.deps.createWindow(floatingBounds(this.deps.workArea(owner.windowBounds()), aspect, this.remembered))
      this.deps.windows.set(FLOATING_WINDOW_ID, win)
      let floating: Floating | null = null
      const loan = page.lendView(FLOATING_WINDOW_ID, (why) => {
        if (why !== 'gone') console.info(`[pip] the floating video of tab ${tabId} ends: its page ${why === 'crashed' ? 'crashed' : 'went to another document'}`)
        if (floating) this.end(floating, 'quiet')
      })
      if (!loan) {
        this.deps.windows.delete(FLOATING_WINDOW_ID)
        win.destroy()
        void page.unstageFloatingVideo?.()
        return { ok: false, reason: 'refused', detail: 'the page could not be lent to the floating window' }
      }
      const bar = this.deps.createBar()
      this.deps.trusted.add(bar.webContents.id)
      // Above the page: the bar covers the whole window, so the page under it is shown but never touched.
      win.contentView.addChildView(bar)
      floating = { tabId, page, owner, win, bar, loan, aspect, pinned: true, facts: null, watch: null, over: false }
      const self = floating
      this.current = floating
      win.setAspectRatio(aspect)
      this.pin(win, true)
      this.layout(floating)
      win.on('resize', () => {
        this.layout(self)
        this.remember(self)
      })
      win.on('move', () => this.remember(self))
      // The keys go to the bar whatever part of the window was clicked (its handle at the top belongs to the window).
      win.on('focus', () => {
        if (!self.over && !bar.webContents.isDestroyed()) bar.webContents.focus()
      })
      // Closed by something else than its bar (the application quits): the view goes back to its tab, nothing is shown.
      win.on('closed', () => this.end(self, 'quiet'))
      // ⌘W in the floating window closes it, as its close button does: left to the menu bar, it would close the tab of the window behind.
      bar.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.meta && !input.shift && !input.alt && !input.control && input.key.toLowerCase() === 'w') {
          event.preventDefault()
          this.end(self, 'close')
        }
      })
      bar.webContents.once('did-finish-load', () => void this.refresh(self))
      owner.floatingChanged(tabId, true)
      // Shown without taking the focus: the user goes on in the window they were in.
      win.showInactive()
      return { ok: true }
    } finally {
      this.starting = false
    }
  }

  /** The window comes back in front of the others (the tab chosen in the sidebar, its mark, the place of its page), without taking the focus. */
  show(): void {
    const floating = this.current
    if (!floating || floating.over || floating.win.isDestroyed()) return
    if (floating.win.isMinimized()) floating.win.restore()
    floating.win.showInactive()
    floating.win.moveTop()
  }

  /** « Revenir à l'onglet » for `tabId`, from the window of the tab (the place of its page). */
  back(tabId: string): void {
    if (this.current && this.floatingTab() === tabId) this.end(this.current, 'back')
  }

  /** The tab leaves its window (another window takes its page), or the application quits: its video goes back to it without showing it. */
  release(tabId?: string): void {
    if (this.current && (tabId === undefined || this.floatingTab() === tabId)) this.end(this.current, 'quiet')
  }

  /** A command of the bar. */
  private async act(floating: Floating, command: FloatingVideoCommand): Promise<void> {
    const { page } = floating
    switch (command.kind) {
      case 'watch':
        if (command.on) this.startWatch(floating)
        else this.stopWatch(floating)
        return
      case 'back':
      case 'close':
        this.end(floating, command.kind)
        return
      case 'pin':
        floating.pinned = !floating.pinned
        this.pin(floating.win, floating.pinned)
        this.push(floating)
        return
      case 'mute': {
        // What the video is now, not what the bar last showed (a stream that started muted since).
        floating.facts = (await page.floatingVideoFacts?.()) ?? floating.facts
        if (floating.over) return
        const steps = muteSteps(this.stateOf(floating))
        floating.owner.setTabMuted(floating.tabId, steps.tabMuted)
        if (steps.unmuteVideo) await page.floatingVideoCommand?.({ kind: 'unmute' })
        break
      }
      case 'seek':
        // A live stream and a protected video are not moved in time from here (`canSeek`), whatever the bar asked.
        if (!canSeek(floating.facts)) return
        await page.floatingVideoCommand?.(command)
        break
      case 'toggle':
      case 'volume':
      case 'live':
        await page.floatingVideoCommand?.(command)
        break
    }
    await this.refresh(floating)
  }

  /** Ends a floating video: the page is given back as it was, the view goes back to its tab, the window and its bar go. */
  private end(floating: Floating, how: Ending): void {
    if (floating.over) return
    floating.over = true
    if (this.current === floating) this.current = null
    this.stopWatch(floating)
    // Closed: the user is done watching (it goes on playing with « Revenir à l'onglet »).
    if (how === 'close') void floating.page.floatingVideoCommand?.({ kind: 'pause' })
    void floating.page.unstageFloatingVideo?.()
    floating.loan.giveBack()
    if (this.deps.windows.get(FLOATING_WINDOW_ID) === floating.win) this.deps.windows.delete(FLOATING_WINDOW_ID)
    this.deps.trusted.delete(floating.bar.webContents.id)
    if (!floating.bar.webContents.isDestroyed()) floating.bar.webContents.close()
    if (!floating.win.isDestroyed()) floating.win.destroy()
    floating.owner.floatingChanged(floating.tabId, false)
    if (how !== 'quiet') floating.owner.showTab(floating.tabId, how === 'back')
  }

  /**
   * « Garder au premier plan »: above the other windows, on every desktop (Space) of the Mac. Not above an application in full screen: that would
   * have Electron hide and show the Dock icon each time (`skipTransformProcessType`).
   */
  private pin(win: BrowserWindow, on: boolean): void {
    if (win.isDestroyed()) return
    win.setAlwaysOnTop(on, 'floating')
    win.setVisibleOnAllWorkspaces(on, { skipTransformProcessType: true })
  }

  private layout(floating: Floating): void {
    if (floating.over || floating.win.isDestroyed()) return
    const { width, height } = floating.win.getContentBounds()
    const all = { x: 0, y: 0, width, height }
    floating.loan.place(all)
    floating.bar.setBounds(all)
  }

  private remember(floating: Floating): void {
    if (!floating.over && !floating.win.isDestroyed()) this.remembered = floating.win.getBounds()
  }

  private stateOf(floating: Floating): FloatingVideoState {
    return { site: floating.owner.siteOf(floating.tabId), pinned: floating.pinned, tabMuted: floating.owner.tabMuted(floating.tabId), facts: floating.facts }
  }

  /** Reads the video again and tells the bar; a video of other proportions (the page put another one in) gives the window its proportions. */
  private async refresh(floating: Floating): Promise<void> {
    const facts = (await floating.page.floatingVideoFacts?.()) ?? null
    if (floating.over) return
    floating.facts = facts
    if (facts && facts.width > 0 && facts.height > 0) {
      const aspect = aspectOf(facts.width, facts.height)
      if (Math.abs(aspect - floating.aspect) > 0.01 && !floating.win.isDestroyed()) {
        floating.aspect = aspect
        floating.win.setAspectRatio(aspect)
      }
    }
    this.push(floating)
  }

  private push(floating: Floating): void {
    const contents = floating.bar.webContents
    if (!floating.over && !contents.isDestroyed()) contents.send(Channel.floatingVideoState, this.stateOf(floating))
  }

  private startWatch(floating: Floating): void {
    if (floating.watch || floating.over) return
    floating.watch = setInterval(() => void this.refresh(floating), FLOATING_WATCH_MS)
    void this.refresh(floating)
  }

  private stopWatch(floating: Floating): void {
    if (floating.watch) clearInterval(floating.watch)
    floating.watch = null
  }
}
