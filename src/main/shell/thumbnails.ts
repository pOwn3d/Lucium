import { activeTab } from '@shared/sidebar'
import type { StateStore } from '../store'
import type { Browser } from './browser'

/** Width of a picture: a card in the sidebar is at most about 400 px wide, doubled for dense screens. */
const WIDTH = 640
/**
 * A page is shot once after it was shown or navigated, when it has most probably drawn: each capture blocks the main process for the time of
 * scaling and encoding the picture (it used to be two, the first of a page that had not settled yet).
 */
export const SHOT_DELAYS_MS = [3000]
/** The quality of the JPEG of a picture. */
const QUALITY = 72
/** The last pictures kept, in memory only: a picture is a page the user looked at, so it never goes to disk or to the state file. */
const KEPT = 80

/** What the panel of ⌃Tab and the hover cards read the pictures through, and how the lock tells the pictures of what it hides to go. */
export interface ThumbnailSource {
  get(tabId: string): string | null
  forgetLocked(): void
}

/**
 * Small pictures of the pages for the hover card of a tab. A hidden page cannot be captured, so the picture of a tab is the
 * last one taken while it was on screen. Only the page being shown is ever captured.
 */
export class Thumbnails implements ThumbnailSource {
  private readonly pictures = new Map<string, string>()
  private timers: NodeJS.Timeout[] = []
  private watching = ''
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    private readonly browser: Browser,
    private readonly store: StateStore
  ) {
    this.unsubscribe = store.subscribe(() => this.onState())
  }

  /** The window is closed: stop listening to the shared state (it would keep this window's browser alive), and forget the pictures. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    this.pictures.clear()
  }

  /** A `data:` URL of the last picture of a tab, or null when it was never on screen since the launch, or when the lock hides the tab (a picture of its page is the page). */
  get(tabId: string): string | null {
    const tab = this.store.get().tabs.find((t) => t.id === tabId)
    return tab && this.browser.isTabLocked(tab) ? null : (this.pictures.get(tabId) ?? null)
  }

  /** The lock changed: the pictures of the tabs it hides are dropped (they are taken again when the tabs are on screen). */
  forgetLocked(): void {
    const tabs = this.store.get().tabs
    for (const tab of tabs) if (this.browser.isTabLocked(tab)) this.pictures.delete(tab.id)
  }

  private onState(): void {
    if (this.disposed) return
    const state = this.store.get()
    const ids = new Set(state.tabs.map((t) => t.id))
    for (const id of this.pictures.keys()) if (!ids.has(id)) this.pictures.delete(id)

    const tab = activeTab(state)
    // A new tab shown, or the shown one going to another address.
    const key = tab ? `${tab.id}|${tab.url}` : ''
    if (key === this.watching) return
    this.watching = key
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (!tab || tab.url === 'about:blank') return
    for (const delay of SHOT_DELAYS_MS) {
      const timer = setTimeout(() => void this.shoot(tab.id).catch((error: unknown) => console.warn('[thumbnails] no picture taken:', error)), delay)
      timer.unref()
      this.timers.push(timer)
    }
  }

  private async shoot(tabId: string): Promise<void> {
    // The battery saver takes no pictures: a capture is a frame the page draws for nothing.
    if (this.disposed || this.browser.powerSaving()) return
    // The page captured is the one being shown: only keep the picture if that is still the tab it was meant for.
    if (activeTab(this.store.get())?.id !== tabId) return
    const jpeg = await this.browser.captureThumbnail(WIDTH, QUALITY)
    if (!jpeg || activeTab(this.store.get())?.id !== tabId) return
    this.pictures.delete(tabId)
    this.pictures.set(tabId, `data:image/jpeg;base64,${jpeg.toString('base64')}`)
    // The oldest pictures go first.
    for (const id of this.pictures.keys()) {
      if (this.pictures.size <= KEPT) break
      this.pictures.delete(id)
    }
  }
}
