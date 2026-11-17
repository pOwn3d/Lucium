import { BrowserWindow, screen } from 'electron'
import { TOOLTIP, type TooltipRequest } from '@shared/ipc'
import { MEDIA_BUBBLE } from '@shared/media-player'

/**
 * The tooltip capsule: navy #090d4e, fully rounded, 29 px tall, 1 px border,
 * the label in bold 12 px lavender and the shortcut as 18 px keycaps. It lives in a window of its own because it drops below the
 * toolbar onto the page, which is a native view above everything the UI can draw.
 * Its policy lets its own style and its one script run and nothing be loaded, like the other pages the main process writes itself.
 * Exported for the tests: the one of its policy, and the one that measures its colours (the keys are small text, 11 px, so they need 4.5:1).
 */
export const TOOLTIP_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; font: 700 12px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
#tip { position: absolute; left: ${TOOLTIP.shadow}px; top: ${TOOLTIP.shadow}px; height: ${TOOLTIP.height}px; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 10px; white-space: nowrap;
  border-radius: ${TOOLTIP.height / 2}px; background: #090d4e; border: 1px solid rgb(255 255 255 / 0.18); color: #cbcff2; box-shadow: 0 3px 8px rgb(0 0 0 / 0.2); }
#keys { display: flex; gap: 3px; }
/* The bubble of the media player: 9 px of margin, a #1e224c edge, the label in semi-bold #d9dbfc. */
#tip.media { gap: 0; padding: 0 ${MEDIA_BUBBLE.padding}px; border-color: #1e224c; color: #d9dbfc; font-weight: 600; }
.key { width: 18px; height: 18px; box-sizing: border-box; display: grid; place-items: center; border-radius: 4px; background: #d2d4ff; border-bottom: 2px solid #8288eb; color: #2438cc; font-size: 11px; }
</style><div id="tip"><span id="text"></span><span id="keys"></span></div><script>
window.setTip = (text, keys, variant) => {
  document.getElementById('tip').className = variant || ''
  document.getElementById('text').textContent = text
  const holder = document.getElementById('keys')
  holder.replaceChildren(...keys.map((k) => { const el = document.createElement('span'); el.className = 'key'; el.textContent = k; return el }))
  return Math.ceil(document.getElementById('tip').getBoundingClientRect().width)
}
</script>`

/**
 * How long the capsule's window is kept after it was last hidden. Its page is a process of its own (a few tens of MB): a window kept for ever kept
 * it for the life of the window it belongs to. A tooltip waits a second of hovering before it shows (`TOOLTIP.delayMs`), which leaves the time
 * to make the window again.
 */
export const TOOLTIP_IDLE_CLOSE_MS = 60_000

export class TooltipWindow {
  private window: BrowserWindow | null = null
  private loaded: Promise<void> | null = null
  /** Each show or hide takes a number: a show that finishes after a later hide must not put the capsule back. */
  private turn = 0
  /** Closes the capsule's window once it has not been shown for TOOLTIP_IDLE_CLOSE_MS. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly parent: BrowserWindow) {}

  /** The capsule's window, once it has been made (for the engine test). */
  current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = new BrowserWindow({
      parent: this.parent,
      type: 'panel',
      width: 300,
      height: TOOLTIP.height + TOOLTIP.shadow * 2,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }
    })
    // Nothing of a tooltip is ever clicked: the pointer goes through it to whatever is under.
    window.setIgnoreMouseEvents(true)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    this.window = window
    this.loaded = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TOOLTIP_PAGE)}`)
    return window
  }

  async show(request: TooltipRequest): Promise<void> {
    if (this.parent.isDestroyed() || this.parent.isMinimized() || !this.parent.isVisible()) return
    const turn = ++this.turn
    this.stopIdleTimer()
    const window = this.ensure()
    await this.loaded
    if (turn !== this.turn || window.isDestroyed()) return
    const width = (await window.webContents.executeJavaScript(`window.setTip(${JSON.stringify(request.text)}, ${JSON.stringify(request.keys ?? [])}, ${JSON.stringify(request.variant ?? '')})`)) as number
    if (turn !== this.turn || window.isDestroyed() || !Number.isFinite(width)) return
    const content = this.parent.getContentBounds()
    const total = width + TOOLTIP.shadow * 2
    const area = screen.getDisplayMatching(content).workArea
    // Right and below the pointer; against the right edge of the screen it opens to the left of the pointer instead, and so it does when it is
    // asked to (`side: 'left'`: a tile of a column docked at the right edge of the window, whose bubble falls on the page).
    const offsetX = request.variant === 'media' ? MEDIA_BUBBLE.offsetX : TOOLTIP.offsetX
    let x = content.x + Math.round(request.x) + offsetX - TOOLTIP.shadow
    if (request.side === 'left' || x + total > area.x + area.width) x = content.x + Math.round(request.x) - offsetX - width - TOOLTIP.shadow
    const y = content.y + Math.round(request.y) + TOOLTIP.offsetY - TOOLTIP.shadow
    window.setBounds({ x: Math.max(area.x, x), y, width: total, height: TOOLTIP.height + TOOLTIP.shadow * 2 })
    window.showInactive()
  }

  hide(): void {
    this.turn++
    if (!this.window || this.window.isDestroyed()) return
    if (this.window.isVisible()) this.window.hide()
    // The count starts again at each hide: a minute without a tooltip, and the window and its process go (the next show makes them again).
    this.stopIdleTimer()
    this.idleTimer = setTimeout(() => this.closeIdle(), TOOLTIP_IDLE_CLOSE_MS)
    this.idleTimer.unref?.()
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /** A show stops the count (`show`): the window that goes here is hidden. One its parent took with it is only forgotten. */
  private closeIdle(): void {
    this.idleTimer = null
    const window = this.window
    this.window = null
    this.loaded = null
    if (window && !window.isDestroyed()) window.destroy()
  }
}
