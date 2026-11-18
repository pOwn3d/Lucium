// The buttons the system draws over a window whose title bar the page draws (Windows: minimise, maximise, close, at the right). The page cannot paint
// them, so what Lucium owns is their height, the colour of their symbols and the room they take. The main process gives the first two to the window
// (`titleBarOverlay`, then `setTitleBarOverlay` whenever a theme, a page or the border changes what is behind them); the interface reads the third from
// the system itself (`env(titlebar-area-*)`, renderer/window-controls.css), never from a number written here: the width of the buttons depends on the
// system, on its scale and on its settings.
//
// Pure: no Electron, no DOM. The platform layer hands the result to the window (main/platform/index.ts, `syncControlsOverlay`).

import { TOOLBAR_BAR_HEIGHT, WEB_APP_HEADER_HEIGHT } from './ipc-layout'
import type { Settings } from './model'
import { contrastOf } from './theme'
import { uiFactor } from './ui-scale'
import { pageMargin } from './window-look'

/** Colours and height of the buttons the system draws over a window whose title bar is hidden (the `titleBarOverlay` of Electron, in CSS pixels of the window). */
export interface ControlsOverlay {
  color: string
  symbolColor: string
  height: number
}

/**
 * The ink of the symbols: `--text-on-space` of tokens.css, the ink the interface writes on the window itself, in its light and its dark scheme. A test keeps
 * both equal to the tokens, so that the symbols and the glyphs of the toolbar next to them are the same two colours.
 */
export const CONTROLS_SYMBOL = { onLight: '#1a1d2b', onDark: '#f1f2f6' } as const

/**
 * The background of the buttons: none. The bar under them shows through, so it keeps the colour of the page, of the space or of the private window, and
 * this file never guesses a colour the stylesheets own.
 */
export const CONTROLS_BACKGROUND = 'rgba(0, 0, 0, 0)'

/** What is behind the buttons, as far as their symbols are concerned. */
export interface ControlsBackdrop {
  /** The scheme of the window (the space's, else the system's). */
  appearance: 'light' | 'dark'
  /** The toolbar is shown, above the page card: the buttons sit over it. Hidden, they sit over the window itself. */
  toolbar: boolean
  /** A split view: its strips are always dark, whatever the page or the window. */
  split: boolean
  /** The colour the page asked for its bar (`theme-color`), hex; none for a page that declares none. */
  pageColor?: string
  /** A private window's bar, which has the colour of the private theme (a blue) when the page has none. */
  privateBar: boolean
}

/** The colour of the symbols that reads on what is behind the buttons. */
export function controlsSymbolColor(back: ControlsBackdrop): string {
  const onScheme = (appearance: 'light' | 'dark'): string => (appearance === 'light' ? CONTROLS_SYMBOL.onLight : CONTROLS_SYMBOL.onDark)
  if (!back.toolbar) return onScheme(back.appearance)
  if (back.split) return CONTROLS_SYMBOL.onDark
  // Black or white, whichever reads more on the bar the page chose: the rule of the glyphs of the toolbar (shared/theme.ts, `toolbarTint`).
  if (back.pageColor) return contrastOf(CONTROLS_SYMBOL.onLight, back.pageColor) >= contrastOf(CONTROLS_SYMBOL.onDark, back.pageColor) ? CONTROLS_SYMBOL.onLight : CONTROLS_SYMBOL.onDark
  return back.privateBar ? CONTROLS_SYMBOL.onDark : onScheme(back.appearance)
}

/**
 * The height of the buttons. In a browser window they cover the row of the toolbar and the border above it (the card starts under them, at
 * `stageTop`); in an application window, the header the page draws (`WEB_APP_HEADER_HEIGHT`). In CSS pixels; the caller scales it with the interface.
 */
export function controlsHeight(o: { kind: 'browser' | 'app'; margin: number }): number {
  return o.kind === 'app' ? WEB_APP_HEADER_HEIGHT : o.margin + TOOLBAR_BAR_HEIGHT
}

/** What the window is given: the buttons over the bar, no background of their own, their symbols in the ink that reads there. */
export function controlsOverlay(o: ControlsBackdrop & { kind: 'browser' | 'app'; margin: number; scale?: number }): ControlsOverlay {
  return { color: CONTROLS_BACKGROUND, symbolColor: controlsSymbolColor(o), height: Math.round(controlsHeight(o) * (o.scale ?? 1)) }
}

/**
 * The buttons a browser window is made with, before any page or theme has told what is behind them: the window's own settings, the system's scheme.
 * The window then follows what it shows (main/shell/browser-layout.ts, `syncControlsOverlay`).
 */
export function firstControlsOverlay(settings: Pick<Settings, 'windowBorder' | 'showToolbar' | 'uiScale'>, o: { dark: boolean; privateBar?: boolean }): ControlsOverlay {
  return controlsOverlay({
    kind: 'browser',
    margin: pageMargin(settings),
    scale: uiFactor(settings.uiScale),
    toolbar: settings.showToolbar,
    split: false,
    appearance: o.dark ? 'dark' : 'light',
    privateBar: o.privateBar === true
  })
}

/**
 * Where the button ☰ opens the menu of the application: the point of the window the interface names (the lower left corner of the button), in CSS pixels.
 * What the interface sends is not trusted: two finite numbers inside the window, rounded; anything else opens nothing.
 */
export function appMenuAnchor(value: unknown, window: { width: number; height: number }): { x: number; y: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y } = value as { x?: unknown; y?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || y < 0 || x > window.width || y > window.height) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/** A strip of a split view, in the stage's coordinates (the strip of a pane is as wide as the pane and sits above it). */
interface Strip {
  x: number
  y: number
  width: number
}

/** The strip that starts the top row of the stage holds the button ☰ (the window has no menu bar). A strip of a lower row, in a stack or a grid, is not at the window's top. */
export const stripHoldsMenu = (pane: Strip): boolean => pane.y <= 0 && pane.x <= 0

/** The strip that ends the top row, at the stage's right edge, is under the buttons of the system and leaves them room. */
export const stripUnderControls = (pane: Strip, stage: { width: number }): boolean => pane.y <= 0 && pane.x + pane.width >= stage.width - 1
