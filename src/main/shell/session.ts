// Remembers where the windows were (Settings › Onglets et fenêtres: restore windows from the previous session): written when a window opens,
// closes, moves or resizes, read at the next launch. The tabs themselves are in the state file.

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { SidebarState } from '@shared/model'
import { EMPTY_SESSION, mayReplaceSession, sessionWindowCount, SHRINK_GRACE_MS, usableSession, type SavedSession } from '@shared/window-session'
import type { Rect } from '@shared/window-layout'
import type { App, BrowserWindow } from 'electron'
import { replaceFileDurably } from '../durable-write'
import { readJsonBounded, SMALL_FILE_MAX_BYTES } from '../persist'
import { reportPersistenceNotice } from '../persistence-notices'
import type { FeatureGates } from './feature-gate'
import type { WindowManager } from './windows'

const SAVE_DELAY_MS = 500
/** A save that failed is tried again after this long (the notice says Lucium tries again). */
const RETRY_DELAY_MS = 30_000

/** The session saved last time, as the screens and the tabs there are now allow it. A missing or unreadable file gives an empty session. */
export function readSession(path: string, displays: readonly Rect[], state: SidebarState): SavedSession {
  if (!existsSync(path)) return EMPTY_SESSION
  try {
    return usableSession(readJsonBounded(path, SMALL_FILE_MAX_BYTES), displays, state)
  } catch (error) {
    // The windows open as usual; the file is overwritten at the next save.
    console.warn(`[session] ${path} is unreadable, the windows open as usual:`, (error as Error).message)
    return EMPTY_SESSION
  }
}

export function writeSession(path: string, session: SavedSession): void {
  replaceFileDurably(path, JSON.stringify(session))
}

/**
 * Saves the session shortly after anything about the windows changes. Two rules keep the last good list through the end of the application, whichever way
 * the windows go away (⌘Q closes the first window last, the red button of each window one by one):
 * - once the quit is decided (`isQuitting`), nothing is saved any more: the windows that close on the way out are not a change the user made;
 * - a list with fewer windows than the saved one waits for `SHRINK_GRACE_MS` of calm before it replaces it (see `mayReplaceSession`), and the saves at the
 *   end (`flush`) leave the saved list alone while it waits.
 */
export class SessionWriter {
  private timer: NodeJS.Timeout | null = null
  /** How many windows the file lists (null when it is not known). */
  private written: number | null
  /** The file as written, to leave it alone when nothing in it would change (a private window opens, the focus moves). */
  private lastText: string | null = null
  /** How many windows there were the last time they were looked at, and when one last went away. */
  private seen: number | null
  private closedAt: number | null = null
  private failing = false

  /** `saved`: how many windows the file listed at launch (the session just read), so that a launch whose windows are not all back yet does not shrink it. */
  constructor(
    private readonly path: string,
    private readonly windows: Pick<WindowManager, 'sessionSnapshot' | 'isQuitting'>,
    saved: number | null = null
  ) {
    this.written = saved
    this.seen = saved
  }

  /** Call after any change to the windows. */
  changed(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
  }

  /** Drops a save that was waiting (the windows are no longer remembered). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Saves the windows as they are now, unless the quit is decided or fewer windows than the file lists are still waiting for their calm. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.windows.isQuitting()) return
    try {
      const session = this.windows.sessionSnapshot()
      // The first window is gone (the application is quitting): what was saved while it was open is the session to keep.
      if (!session.main) return
      const count = sessionWindowCount(session)
      if (this.seen !== null && count < this.seen) this.closedAt = Date.now()
      this.seen = count
      const since = this.closedAt === null ? null : Date.now() - this.closedAt
      if (!mayReplaceSession(count, this.written, since)) {
        this.timer = setTimeout(() => this.flush(), Math.max(SAVE_DELAY_MS, SHRINK_GRACE_MS - (since ?? 0)))
        return
      }
      const text = JSON.stringify(session)
      if (text !== this.lastText) writeSession(this.path, session)
      this.lastText = text
      this.written = count
      if (this.failing) {
        this.failing = false
        console.warn(`[session] ${this.path} can be written again`)
      }
    } catch (error) {
      this.failed(error)
    }
  }

  private failed(error: unknown): void {
    if (!this.failing) {
      this.failing = true
      console.error('[session] cannot save the windows, the save is tried again:', error)
      reportPersistenceNotice({ kind: 'save-failed', file: basename(this.path), reason: String((error as Error).message ?? error) })
    }
    if (!this.windows.isQuitting()) this.timer = setTimeout(() => this.flush(), RETRY_DELAY_MS)
  }
}

/**
 * Remembers where the windows are only while "Rouvrir les fenêtres de la session précédente" is on: no listener on the windows and no write
 * of windows.json otherwise. Switched on during the session, it saves the windows as they are at once.
 */
export function gateWindowMemory(gates: FeatureGates, deps: { win: Pick<BrowserWindow, 'on' | 'off'>; app: Pick<App, 'on' | 'off'>; windows: Pick<WindowManager, 'onChange'>; writer: SessionWriter }): void {
  const { win, app, windows, writer } = deps
  let launching = true
  gates.gate('restore-windows', {
    start: () => {
      const changed = (): void => writer.changed()
      // Before the window closes: afterwards the other windows are gone too, and so is what there was to remember.
      const flush = (): void => writer.flush()
      const unlisten = windows.onChange(changed)
      win.on('resize', changed)
      win.on('move', changed)
      win.on('close', flush)
      app.on('before-quit', flush)
      if (!launching) writer.changed()
      return () => {
        unlisten()
        win.off('resize', changed)
        win.off('move', changed)
        win.off('close', flush)
        app.off('before-quit', flush)
        writer.cancel()
      }
    }
  })
  launching = false
}
