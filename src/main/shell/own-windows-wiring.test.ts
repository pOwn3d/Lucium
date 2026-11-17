// The windows of their own main() makes at the start (shell/own-windows-wiring.ts), run over a stand-in of Electron (own-windows.test-support.ts): what they
// tell the engine and the browser as they are made. The windows themselves are checked in a running Electron (the engine checks of the windows).

import { describe, expect, it, vi } from 'vitest'
import { screenOf, withPanelSize } from '@shared/panel-scale'
import { SETTINGS_WINDOW_OPTIONS } from './settings-window'
import { displayOf, ownWindows, windowsWorld } from './own-windows.test-support'

vi.mock('electron', async () => (await import('./own-windows.test-support')).windowsElectron())

describe('the mini windows', () => {
  it('are what the « Ouvrir en mini-fenêtre » button of an error page opens: the opener main() gives the engine opens the address in one of them', async () => {
    const { engine, browser } = await ownWindows({ browserOwn: { openLittle: vi.fn() } })
    const opener = engine.calls.find((call) => call.name === 'setMiniWindowOpener')!.args[0] as (url: string) => void
    opener('https://absent.example/page')
    expect(browser.self['openLittle']).toHaveBeenCalledExactlyOnceWith('https://absent.example/page')
  })
})

describe('the windows of their own, and the size of the panels', () => {
  const ULTRAWIDE = displayOf('LG UltraWide', 3440, 1440)
  const sizes = withPanelSize({}, screenOf(ULTRAWIDE)!, 140, 1)
  /** The base size of each of the three, at 100 %. */
  const bases = [SETTINGS_WINDOW_OPTIONS, { width: 720, height: 480, minWidth: 420, minHeight: 260 }, { width: 340, height: 520 }]

  /** The windows of the application the user is in, on the ultrawide screen whose choice is 140 %; the three windows of their own are opened. */
  async function opened(focused: boolean) {
    windowsWorld.reset()
    windowsWorld.display = ULTRAWIDE
    windowsWorld.focused = focused ? { x: 100, y: 100, width: 1200, height: 800 } : null
    const harness = await ownWindows({ settings: { panelSizes: sizes } })
    const own = harness.made as unknown as { settings: { open(): void }; taskManager: { open(): void }; aboutWindow: { open(): void } }
    own.settings.open()
    own.taskManager.open()
    own.aboutWindow.open()
    return { harness, windows: [...windowsWorld.made] }
  }

  it('are made through the scaling, all three: Réglages, the task manager and À propos (the Extensions page is a tab, no window)', async () => {
    const { windows } = await opened(true)
    expect(windows).toHaveLength(3)
    for (const [at, base] of bases.entries()) {
      const win = windows[at]!
      // Made at the size the screen gives them (more than the fixed one), in the middle of its work area, and their page zoomed as much.
      expect(win.options['width'], `window ${at}`).toBeGreaterThan(base.width)
      expect(win.options['height'], `window ${at}`).toBeGreaterThan(base.height)
      expect(typeof win.options['x'], `window ${at}`).toBe('number')
      expect(win.webContents.zoom, `window ${at}`).toBeGreaterThan(1)
    }
  })

  it('share one scaling, over the shared state and placed where the user works (the focused window): they follow a change of the choices, and a window opened with none in front goes by the primary screen', async () => {
    const { harness, windows } = await opened(true)
    const zoom = windows[0]!.webContents.zoom
    expect(zoom).toBeGreaterThan(1)
    // The choice is put back to Automatique: the three windows follow, through the one subscription to the shared state.
    harness.change({ panelSizes: {} })
    for (const win of windows) expect(win.webContents.zoom).toBeLessThan(zoom)
    // With no window of the application in front, a new one opens on the primary screen: nothing of the ultrawide's choice reaches it.
    windowsWorld.reset()
    const blind = await ownWindows({ settings: { panelSizes: sizes } })
    windowsWorld.display = ULTRAWIDE
    ;(blind.made as unknown as { aboutWindow: { open(): void } }).aboutWindow.open()
    expect(windowsWorld.made[0]!.webContents.zoom).toBeLessThan(zoom)
  })
})
