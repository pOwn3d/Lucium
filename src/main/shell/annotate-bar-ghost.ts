// What a drag of the grip of the annotation bar shows over the window (docs/design/annotation-partage-fenetre.md, « Position de la barre »): the four drop zones
// along the edges of the window, faint, the one under the pointer lit, and the dashed outline of where the bar lands in it. One window of its own, the size of the
// window the bar is dragged in, as the bar is: transparent, never in front of the pointer, never the focus, and outside the picture of a shared window. It exists
// for the length of a drag only (made when the drag starts, destroyed at the drop): nothing runs for it the rest of the time.

import { BrowserWindow } from 'electron'
import type { Bounds } from '../engine/types'
import type { BarEdge } from '@shared/annotate-bar-position'
import { barHue } from '@shared/page-annotate'
import tokensCss from '../../renderer/tokens.css?raw'

/** The edges, in the order the zones are written. */
const EDGES: readonly BarEdge[] = ['left', 'right', 'top', 'bottom']

/**
 * The declaration of a token as tokens.css writes it (`--accent: light-dark(…);`). The overlay is a page of its own that loads no stylesheet (its policy lets
 * nothing in), so the few tokens it draws with are copied into it from the sheet, not written a second time here.
 */
export function tokenDeclaration(css: string, name: string): string {
  const found = new RegExp(`^\\s*(${name}:[^;]+;)`, 'm').exec(css)
  if (!found) throw new Error(`annotation bar: tokens.css declares no ${name}`)
  return found[1]!
}

/** The accent of the theme and what it is worked out from, for the hue given: light in light and dark in dark, as the root of tokens.css is. */
const accentTokens = (hue: number): string => `:root { color-scheme: light dark; --hue: ${barHue(hue)}; ${tokenDeclaration(tokensCss, '--accent-l')} ${tokenDeclaration(tokensCss, '--accent')} }`

/**
 * The page of the overlay, made for a window at `reference` (the coordinates of the screen) with the zones `zones` (the same) in it, none lit and no outline. Its
 * colours are the accent of the theme at the hue of the space on screen (`hue`), the one the pressed buttons of the bar take (renderer/page-annotate-command.html),
 * faint for a zone and plain for the one under the pointer. No script of its own: `ghostCall` lights a zone and puts the outline, from the main process.
 */
export function ghostPage(reference: Bounds, zones: Record<BarEdge, Bounds>, hue?: number): string {
  const px = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0)
  const boxes = EDGES.map((edge) => {
    const zone = zones[edge]
    return `<div class="zone zone-${edge}" style="left:${px(zone.x - reference.x)}px;top:${px(zone.y - reference.y)}px;width:${px(zone.width)}px;height:${px(zone.height)}px"></div>`
  }).join('')
  const tint = (percent: number): string => `color-mix(in srgb, var(--accent) ${percent}%, transparent)`
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
${accentTokens(barHue(hue))}
html, body { margin: 0; background: transparent; overflow: hidden; }
.zone { position: fixed; box-sizing: border-box; background: ${tint(7)}; border: 1px dashed ${tint(45)}; }
html[data-target="left"] .zone-left, html[data-target="right"] .zone-right, html[data-target="top"] .zone-top, html[data-target="bottom"] .zone-bottom { background: ${tint(30)}; border: 2px solid var(--accent); }
#landing { position: fixed; box-sizing: border-box; border: 2px dashed var(--accent); border-radius: 16px; background: ${tint(10)}; }
#landing[hidden] { display: none; }
@media (prefers-reduced-motion: no-preference) { .zone { transition: background-color 90ms ease; } }
</style>${boxes}<div id="landing" hidden></div>`
}

/**
 * The call that lights the zone of `edge` (null: none) and puts the outline at `landing` (the coordinates of the screen; null: no outline), for the overlay at
 * `reference`. A script of numbers and of one of the four names of an edge: nothing else is ever put in it.
 */
export function ghostCall(edge: BarEdge | null, landing: Bounds | null, reference: Bounds): string {
  const lit = edge !== null && EDGES.includes(edge) ? edge : ''
  const outline =
    landing !== null && [landing.x, landing.y, landing.width, landing.height, reference.x, reference.y].every(Number.isFinite)
      ? `o.style.cssText='left:${Math.round(landing.x - reference.x)}px;top:${Math.round(landing.y - reference.y)}px;width:${Math.round(landing.width)}px;height:${Math.round(landing.height)}px';o.hidden=false`
      : 'o.hidden=true'
  return `(()=>{document.documentElement.dataset.target=${JSON.stringify(lit)};const o=document.getElementById('landing');if(o){${outline}}})()`
}

export class BarGhost {
  private window: BrowserWindow | null = null
  private reference: Bounds | null = null
  private loaded = false
  /** The last call asked for: it is run again once the page has loaded, when it was asked for before. */
  private last: string | null = null

  /** Opens the overlay over `reference` (the coordinates of the screen), with the drop zones `zones` in it, in the accent of the hue `hue`: all faint, none lit. */
  open(reference: Bounds, zones: Record<BarEdge, Bounds>, hue?: number): void {
    this.dispose()
    this.reference = reference
    const window = this.make(reference, zones, hue)
    this.window = window
    window.showInactive()
  }

  /** Lights the zone of `edge` and shows the outline of where the bar lands in it: the pointer is in that zone. Null: the pointer is in none. */
  target(edge: BarEdge | null, landing: Bounds | null): void {
    if (!this.window || this.window.isDestroyed() || !this.reference) return
    this.last = ghostCall(edge, landing, this.reference)
    this.run()
  }

  /** Ends the overlay: its window is closed, with its page. */
  dispose(): void {
    const window = this.window
    this.window = null
    this.reference = null
    this.loaded = false
    this.last = null
    if (window && !window.isDestroyed()) window.destroy()
  }

  /** The window of the overlay, once it has been made (for the tests). */
  current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  private run(): void {
    const window = this.window
    if (!this.loaded || !this.last || !window || window.isDestroyed()) return
    // A call that fails leaves the zones as they were: the drag goes on, and the drop does not depend on what the overlay shows. It is logged, not hidden.
    window.webContents.executeJavaScript(this.last).catch((error: unknown) => console.warn('[page-annotate] the drop zones could not be updated:', error))
  }

  private make(reference: Bounds, zones: Record<BarEdge, Bounds>, hue?: number): BrowserWindow {
    const window = new BrowserWindow({
      ...reference,
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
      // A page of a few boxes of style and nothing else: no preload, nothing from outside, and nothing that can be opened from it. Its only script is the one this
      // process runs in it (`ghostCall`).
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }
    })
    // Nothing of the overlay is ever clicked: the pointer goes through it to what is under.
    window.setIgnoreMouseEvents(true)
    // Above the page, as the bar is (the bar is brought above it once it is shown).
    window.setAlwaysOnTop(true, 'floating')
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('did-finish-load', () => {
      this.loaded = true
      this.run()
    })
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ghostPage(reference, zones, hue))}`)
    return window
  }
}
