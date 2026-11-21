// A layer of ElectronPage (electron-page.ts): the life of the page beyond its document (what holds a sleep, freezing and thawing, the view
// lent to another window, the move to another window, the close for a sleep and the end). Cut out of electron-page.ts as it was.

import { BrowserWindow } from 'electron'
import type { PageProbe } from '@shared/sleep'
import type { ViewLoan } from './types'
import { SLEEP_PROBE, probeWithFrames } from './sleep-probe'
import { SLEEP_WORLD, SLEEP_PROBE_TIMEOUT_MS, RELEASE_ANSWER_MS, TRACK_INPUT } from './electron-page-scripts'
import { ElectronPageMedia } from './electron-page-media'

export abstract class ElectronPageLifecycle extends ElectronPageMedia {
  private disarmTrackInput: (() => void) | null = null
  /**
   * Arms the watcher of what the user types in this document, for `probeForSleep`: nothing is put in the page until the first key or
   * click reaches it (Chromium tells the main process of both, frames included), so a page nobody types in carries no listener.
   */
  protected trackInput(): void {
    this.disarmTrackInput?.()
    const wc = this.webContents
    const arm = (typedKey: boolean): void => {
      this.disarmTrackInput?.()
      // A key that types a character may have reached the field before the watcher was in: it is read from the field once it is.
      const code = typedKey ? `${TRACK_INPUT};self.__luciumNoteFocused && self.__luciumNoteFocused()` : TRACK_INPUT
      wc.executeJavaScriptInIsolatedWorld(SLEEP_WORLD, [{ code }]).catch((error: unknown) => {
        // Without the watcher the page just reports no typed text: that costs a sleep decision some caution, not a failure.
        if (!this.gone) console.warn(`[engine] cannot watch the fields of page ${this.id}:`, (error as Error).message)
      })
    }
    const onKey = (_event: unknown, input: { type: string; key?: string; meta?: boolean; control?: boolean }): void => {
      if (input.type !== 'keyDown') return
      arm((input.key ?? '').length === 1 && !input.meta && !input.control)
    }
    const onMouse = (_event: unknown, mouse: { type: string }): void => {
      if (mouse.type === 'mouseDown') arm(false)
    }
    wc.on('before-input-event', onKey)
    wc.on('before-mouse-event', onMouse)
    this.disarmTrackInput = () => {
      this.disarmTrackInput = null
      wc.off('before-input-event', onKey)
      wc.off('before-mouse-event', onMouse)
    }
  }
  async probeForSleep(): Promise<PageProbe | null> {
    if (this.gone || this.frozen) return null
    let timer: NodeJS.Timeout | undefined
    try {
      // The page answers in its sleep world; its frames (an embedded player) are asked too whether they float a video (sleep-probe.ts).
      const main = this.webContents.mainFrame
      const asked = this.webContents
        .executeJavaScriptInIsolatedWorld(SLEEP_WORLD, [{ code: SLEEP_PROBE }])
        .then((own) => probeWithFrames(own as Partial<PageProbe> | null, main.framesInSubtree.filter((frame) => frame !== main)))
      return await Promise.race([
        asked,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), SLEEP_PROBE_TIMEOUT_MS)
        })
      ])
    } catch {
      // Navigating, crashed or closed while asked: it could not tell.
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  private queueLifecycle<T>(job: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(job)
    this.lifecycle = run.catch(() => undefined)
    return run
  }
  /** Sets the page lifecycle through the protocol, using the debugger session already attached (an extension's) or one of our own. */
  private async setLifecycleState(state: 'frozen' | 'active'): Promise<boolean> {
    if (this.gone) return false
    const dbg = this.webContents.debugger
    const attachedByUs = !dbg.isAttached()
    try {
      if (attachedByUs) dbg.attach('1.3')
      await dbg.sendCommand('Page.setWebLifecycleState', { state })
      return true
    } catch (error) {
      if (!this.gone) console.warn(`[engine] cannot set page ${this.id} to ${state}:`, (error as Error).message)
      return false
    } finally {
      // Detaching leaves the page frozen: only the command freezes it.
      if (attachedByUs && !this.gone && dbg.isAttached()) dbg.detach()
    }
  }
  freeze(): Promise<boolean> {
    return this.queueLifecycle(async () => {
      if (this.frozen) return true
      this.frozen = await this.setLifecycleState('frozen')
      return this.frozen
    })
  }
  async thaw(): Promise<void> {
    await this.queueLifecycle(async () => {
      if (!this.frozen) return
      if (await this.setLifecycleState('active')) this.frozen = false
    })
  }

  lendView(windowId: string, ended: (why: 'gone' | 'crashed' | 'navigated') => void): ViewLoan | null {
    if (this.gone || this.loan || this.errors.showsErrorPage() || this.reader.isOpen()) return null
    let host: BrowserWindow | undefined
    try {
      host = this.lendHost?.(windowId)
    } catch (error) {
      console.warn(`[engine] page ${this.id} cannot be lent to window ${windowId}:`, (error as Error).message)
      return null
    }
    if (!host || host.isDestroyed() || host === this.win) return null
    const wc = this.webContents
    this.hide()
    const view = this.view
    const out = (): void => {
      if (!host.isDestroyed()) host.contentView.removeChildView(view)
    }
    const gone = (): void => end('gone')
    const crashed = (): void => end('crashed')
    // Another document is not the video that was floated: the view goes back to its tab (a site that changes its page in place keeps it).
    const navigated = (): void => end('navigated')
    const end = (why: 'gone' | 'crashed' | 'navigated' | 'given'): void => {
      if (this.loan?.host !== host) return
      this.loan = null
      wc.removeListener('destroyed', gone)
      wc.removeListener('render-process-gone', crashed)
      wc.removeListener('did-navigate', navigated)
      out()
      if (why !== 'given') ended(why)
    }
    this.loan = { host, end }
    wc.once('destroyed', gone)
    wc.on('render-process-gone', crashed)
    wc.on('did-navigate', navigated)
    host.contentView.addChildView(view)
    view.setBorderRadius(0)
    this.radius = 0
    return {
      place: (bounds) => {
        if (this.loan?.host !== host) return
        view.setBounds(bounds)
        // Drawn again as it comes into its new window (a page that was out of sight can come as a black rectangle, see `show`).
        if (!wc.isDestroyed()) wc.invalidate()
      },
      raise: () => {
        if (this.loan?.host === host && !host.isDestroyed()) host.contentView.addChildView(view)
      },
      giveBack: () => end('given')
    }
  }

  moveToWindow(windowId: string | undefined): boolean {
    // Our covers were made in the window the page is in: a page under one is made again instead (an error page or an article has nothing under way).
    // A page lent to the floating window is given back first (the shell does): it does not go anywhere from there.
    if (this.gone || this.loan || !this.relocate || this.errors.showsErrorPage() || this.reader.isOpen()) return false
    let next: BrowserWindow | undefined
    try {
      next = this.relocate(windowId)
    } catch (error) {
      console.warn(`[engine] page ${this.id} cannot go to window ${windowId ?? 'main'}:`, (error as Error).message)
      return false
    }
    if (!next) return false
    if (next === this.win) return true
    this.hide()
    this.win = next
    for (const host of this.hangers) host.win = next
    return true
  }

  destroy(): void {
    this.loan?.end('gone')
    this.hide()
    if (this.gone) return
    this.keepHistory()
    this.endOfPage()
    this.webContents.close()
  }

  /** What goes with the page once it is closing: from now on, late results from it (a load that never finished) are expected (`close()` is asynchronous). */
  private endOfPage(): void {
    this.closing = true
    // A menu held for a gesture has nothing left to open on.
    if (this.held) clearTimeout(this.held.timer)
    this.held = null
    // Clean up loading timeout for SPAs
    this.loadingTimer.cancel()
    this.errors.dispose()
    this.reader.dispose()
  }

  /**
   * Closes the page for a sleep, unless it asks to confirm leaving: Chromium runs its `beforeunload` (in every frame, a frame of another site
   * included; a document the user never touched cannot hold it), and a page that cancels it keeps the close from happening. A page out of sight has
   * nobody to ask, so it is not taken without a question: it stays as it is, and the answer is false. True once the page is closed. A page that
   * answers neither way within `RELEASE_ANSWER_MS` is closed as `destroy` closes it.
   */
  release(): Promise<boolean> {
    if (this.gone) return Promise.resolve(true)
    if (this.releasing) return this.releasing.promise
    const wc = this.webContents
    let settle!: (gone: boolean) => void
    const promise = new Promise<boolean>((resolve) => (settle = resolve))
    let timer: NodeJS.Timeout | undefined
    const ended = (): void => settleWith(true)
    const settleWith = (gone: boolean): void => {
      if (this.releasing?.promise !== promise) return
      this.releasing = null
      clearTimeout(timer)
      wc.removeListener('destroyed', ended)
      if (gone && !this.closing) this.endOfPage()
      if (!gone) this.forgetKeptHistory()
      settle(gone)
    }
    this.releasing = { settle: settleWith, promise }
    this.hide()
    wc.once('destroyed', ended)
    // The list is read now: the sleep that follows the close asks for it when the web contents is gone.
    this.keepHistory()
    timer = setTimeout(() => {
      if (this.releasing?.promise !== promise) return
      console.warn(`[engine] page ${this.id} did not answer the close of a sleep within ${RELEASE_ANSWER_MS} ms: it is closed`)
      this.keepHistory()
      this.endOfPage()
      wc.close()
      settleWith(true)
    }, RELEASE_ANSWER_MS)
    try {
      wc.close({ waitForBeforeUnload: true })
    } catch (error) {
      console.warn(`[engine] page ${this.id} could not be closed for a sleep:`, (error as Error).message)
      settleWith(this.gone)
    }
    return promise
  }
}
