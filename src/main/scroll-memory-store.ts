// The file of the scroll memory: `scroll.json` in the data folder, next to state.json but never part of it. One number per tab and the address it
// was read on (shared/scroll-memory.ts), nothing of a page. It is read the first time a tab asks for its position (never while the function is off,
// never at startup), and written a few seconds after the last change, and at quit. A file that cannot be read is set aside and the memory starts again
// from none (persist.ts). One memory for all the windows: it is a module-level service, as the lock service is.

import { existsSync } from 'node:fs'
import { SMALL_FILE_MAX_BYTES, isHeld, readTextBounded, setAsideOrHold, writeFileAtomic } from './persist'
import { parseScrollFile, scrollFileText, scrollKeptFor, scrollRemembered, scrollToRestore, type ScrollMemory } from '@shared/scroll-memory'

/** How long after a change the file is written: a page scrolled for a minute is one write. */
export const SCROLL_SAVE_DELAY_MS = 5000

export class ScrollMemoryStore {
  private memory: ScrollMemory = new Map()
  private loaded = false
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  /** `path` null: a memory that lives in the process only (a test, a smoke run). */
  constructor(
    private readonly path: string | null,
    private readonly now: () => number = Date.now
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (this.path === null || isHeld(this.path) || !existsSync(this.path)) return
    try {
      this.memory = parseScrollFile(readTextBounded(this.path, SMALL_FILE_MAX_BYTES))
    } catch (error) {
      setAsideOrHold(this.path, error, 'scroll-memory')
    }
  }

  /** The tab's page stopped at `y` on `url`. */
  remember(tabId: string, url: string, y: number): void {
    this.load()
    const next = scrollRemembered(this.memory, tabId, url, y, this.now())
    const before = this.memory.get(tabId)
    const after = next.get(tabId)
    this.memory = next
    // Nothing to write when the tab had nothing and still has nothing, or the same spot.
    if (before === undefined && after === undefined) return
    if (before !== undefined && after !== undefined && before.url === after.url && before.y === after.y) return
    this.markDirty()
  }

  /** Where the tab's page was left, when it is at the address that position was read on. */
  positionFor(tabId: string, url: string): number | undefined {
    this.load()
    return scrollToRestore(this.memory, tabId, url)
  }

  /** The tabs that are gone take their positions with them. Never reads the file: a memory not yet loaded has nothing to forget, and what it loads later is pruned by the next call. */
  forget(live: ReadonlySet<string>): void {
    const kept = scrollKeptFor(this.memory, live)
    if (kept === this.memory) return
    this.memory = kept
    this.markDirty()
  }

  /** Writes now what is waiting to be written (the quit). A failure is logged: the positions of this run are lost, the next change tries again. */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty || this.path === null) return
    try {
      writeFileAtomic(this.path, scrollFileText(this.memory))
      this.dirty = false
    } catch (error) {
      console.error(`[scroll-memory] cannot write ${this.path}:`, error)
    }
  }

  private markDirty(): void {
    this.dirty = true
    if (this.timer !== null || this.path === null) return
    this.timer = setTimeout(() => this.flush(), SCROLL_SAVE_DELAY_MS)
    // A timer must not keep the application alive at quit: `flush` is called there.
    this.timer.unref()
  }
}

let service: ScrollMemoryStore = new ScrollMemoryStore(null)

/** The memory of the application (in the process only until `initScrollMemory` gave it a file). */
export const scrollMemory = (): ScrollMemoryStore => service

export function initScrollMemory(path: string | null): ScrollMemoryStore {
  service = new ScrollMemoryStore(path)
  return service
}
