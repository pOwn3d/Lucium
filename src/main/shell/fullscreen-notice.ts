// The notice over a page that took the window in HTML full screen (rules in shared/fullscreen-notice.ts): the site, and Escape to leave. The page
// is a native view raised above everything the interface draws, so the notice is a view of its own, laid above that page by the layout of the
// window (browser-layout.ts). It never takes the focus, so that Escape and the keys of a video player stay the page's, and it exists only while it
// is on screen: made when a page takes the window, closed when it goes.

import { WebContentsView, type BrowserWindow, type View } from 'electron'
import { escapeHtml } from '@shared/html-escape'
import { NO_FULLSCREEN_NOTICE, fullscreenNoticeAt, fullscreenNoticeLines, type FullscreenNoticeState } from '@shared/fullscreen-notice'
import { getLanguage } from '@shared/i18n'
import tokensCss from '../../renderer/tokens.css?raw'
import { coverUrl } from '../engine/page-cover'
import type { Bounds } from '../engine/types'
import { tokenDeclaration } from './annotate-bar-ghost'

/** The gap between the top edge of the window and the notice, and the transparent margin its shadow is drawn in (CSS pixels, at the size of the page). */
export const NOTICE_TOP = 16
export const NOTICE_SHADOW = 12

/** The roles of tokens.css the notice is drawn with, copied into its page (it loads no stylesheet): light in light and dark in dark, as the panels are. */
const NOTICE_TOKENS = ['--surface', '--text', '--text-2', '--line-strong', '--shadow-s', '--font', '--r-l', '--t-m', '--t-s', '--w-semibold', '--sp-1', '--sp-3', '--sp-4'] as const

/**
 * The page of the notice: the two lines, written as text, in the language of the interface (a screen reader reads them in it). No script and
 * nothing to load: its policy lets only its own style in.
 */
export function fullscreenNoticePage(lines: { site: string; exit: string }, css: string = tokensCss): string {
  const tokens = NOTICE_TOKENS.map((name) => tokenDeclaration(css, name)).join(' ')
  return `<!doctype html><html lang="${getLanguage()}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
:root { color-scheme: light dark; ${tokens} }
html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; cursor: default; }
#notice { position: absolute; left: ${NOTICE_SHADOW}px; top: ${NOTICE_SHADOW}px; width: max-content; box-sizing: border-box; padding: var(--sp-3) var(--sp-4);
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); border-radius: var(--r-l); background: var(--surface);
  border: 1px solid var(--line-strong); box-shadow: var(--shadow-s); font-family: var(--font); white-space: nowrap; text-align: center; }
#site { font-size: var(--t-m); font-weight: var(--w-semibold); color: var(--text); }
#exit { font-size: var(--t-s); color: var(--text-2); }
</style><div id="notice" role="status"><div id="site">${escapeHtml(lines.site)}</div><div id="exit">${escapeHtml(lines.exit)}</div></div>`
}

/** What the page of the notice measures of itself once loaded: the size of the notice, in CSS pixels. */
const MEASURE = `(() => { const r = document.getElementById('notice').getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)] })()`

/** Where the view of the notice goes in a window whose content is `content`: centred, near the top edge, never wider than the window. */
export function noticeBounds(content: Pick<Bounds, 'width' | 'height'>, size: { width: number; height: number }): Bounds {
  const width = Math.min(content.width, size.width + NOTICE_SHADOW * 2)
  const height = Math.min(content.height, size.height + NOTICE_SHADOW * 2)
  return { x: Math.max(0, Math.round((content.width - width) / 2)), y: Math.max(0, NOTICE_TOP - NOTICE_SHADOW), width, height }
}

export class FullscreenNotice {
  private state: FullscreenNoticeState = NO_FULLSCREEN_NOTICE
  private view: WebContentsView | null = null
  /** The size of the notice once its page has measured it; until then nothing is put on the window (an empty view would hide a corner of the page). */
  private size: { width: number; height: number } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly win: BrowserWindow,
    /** Lays the window out again: when the notice is ready to be drawn, and when its time is over. */
    private readonly relayout: () => void,
    private readonly now: () => number = Date.now
  ) {
    // The page of the notice is a view of this window: it goes with the window, and its time does not run on after it.
    win.once('closed', () => this.close())
  }

  /**
   * Called by the layout with the tab that holds the window in full screen (null: none) and the address of its page. Answers the view to put above
   * the page, with its place, or null when no notice is on screen (the view is then closed).
   */
  follow(fullscreenTab: string | null, url: string | undefined, content: Pick<Bounds, 'width' | 'height'>): { view: View; bounds: Bounds } | null {
    const before = this.state
    const step = fullscreenNoticeAt(before, fullscreenTab, this.now())
    this.state = step.state
    if (!step.shown) {
      this.close()
      return null
    }
    if (step.state !== before) this.open(url ?? '', step.state.until)
    return this.view && this.size ? { view: this.view, bounds: noticeBounds(content, this.size) } : null
  }

  /** The view on screen, if any (the engine test reads it). */
  current(): WebContentsView | null {
    return this.view && this.size ? this.view : null
  }

  private open(url: string, until: number): void {
    this.close()
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } })
    view.setBackgroundColor('#00000000')
    // A page of ours that goes nowhere: no window, no navigation.
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event) => event.preventDefault())
    this.view = view
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.win.isDestroyed()) this.relayout()
    }, Math.max(0, until - this.now()))
    void this.measure(view, url)
  }

  private async measure(view: WebContentsView, url: string): Promise<void> {
    let reason: string
    try {
      await view.webContents.loadURL(coverUrl(fullscreenNoticePage(fullscreenNoticeLines(url))))
      const size: unknown = await view.webContents.executeJavaScript(MEASURE)
      // A notice closed meanwhile (the page left full screen within the load) has nothing left to draw: its closing was the answer.
      if (this.view !== view) return
      const [width, height] = Array.isArray(size) ? size : []
      if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 && Number.isFinite(width + height)) {
        this.size = { width, height }
        if (!this.win.isDestroyed()) this.relayout()
        return
      }
      reason = `its page measured ${JSON.stringify(size)}`
    } catch (error) {
      if (this.view !== view) return
      reason = error instanceof Error ? error.message : String(error)
    }
    // Without its notice the page still leaves full screen with Escape (the lock of the keyboard is refused to pages): said in the log, with why.
    console.warn(`[fullscreen] the notice over a page in full screen could not be drawn: ${reason}`)
    this.close()
  }

  /** Takes the notice off the window and closes its page (its process goes with it). */
  close(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const view = this.view
    this.view = null
    this.size = null
    if (!view) return
    if (!this.win.isDestroyed() && this.win.contentView.children.includes(view)) this.win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
}
