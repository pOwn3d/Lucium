// The window of the tooltip capsule is a process of its own: it goes after a minute without a tooltip, and comes back with the next one.
// Run over a fake of Electron's window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const made = vi.hoisted(() => [] as Array<{ visible: boolean; destroyed: boolean; destroy: () => void }>)
vi.mock('electron', () => {
  class FakeWindow {
    visible = false
    destroyed = false
    readonly webContents = { setWindowOpenHandler: () => undefined, on: () => undefined, executeJavaScript: async () => 120 }
    constructor() {
      made.push(this)
    }
    isDestroyed = (): boolean => this.destroyed
    isMinimized = (): boolean => false
    isVisible = (): boolean => this.visible
    setIgnoreMouseEvents = (): void => undefined
    loadURL = async (): Promise<void> => undefined
    getContentBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 })
    setBounds = (): void => undefined
    showInactive = (): void => {
      this.visible = true
    }
    hide = (): void => {
      this.visible = false
    }
    destroy = (): void => {
      this.destroyed = true
    }
  }
  return { BrowserWindow: FakeWindow, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }) } }
})

const { TooltipWindow, TOOLTIP_IDLE_CLOSE_MS, TOOLTIP_PAGE } = await import('./tooltip')
const { AA_TEXT, contrastRatio } = await import('@shared/contrast')
const { BrowserWindow } = await import('electron')

const parent = (): never => {
  const window = new BrowserWindow() as unknown as { visible: boolean }
  window.visible = true
  return window as never
}
const request = { text: 'Nouvel onglet', x: 10, y: 10 }

beforeEach(() => {
  made.length = 0
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('the window of the tooltip', () => {
  it('goes a minute after the tooltip was last hidden, and a new one is made for the next tooltip', async () => {
    const tooltip = new TooltipWindow(parent())
    await tooltip.show(request)
    const first = tooltip.current()
    expect(first?.isVisible()).toBe(true)
    tooltip.hide()
    vi.advanceTimersByTime(TOOLTIP_IDLE_CLOSE_MS - 1)
    expect(tooltip.current()).toBe(first)
    vi.advanceTimersByTime(1)
    expect(first?.isDestroyed()).toBe(true)
    expect(tooltip.current()).toBeNull()
    await tooltip.show(request)
    expect(tooltip.current()).not.toBe(first)
    expect(tooltip.current()?.isVisible()).toBe(true)
  })

  it('stays while tooltips keep coming: each one starts the minute again', async () => {
    const tooltip = new TooltipWindow(parent())
    await tooltip.show(request)
    const first = tooltip.current()
    tooltip.hide()
    vi.advanceTimersByTime(TOOLTIP_IDLE_CLOSE_MS - 1000)
    await tooltip.show(request)
    vi.advanceTimersByTime(TOOLTIP_IDLE_CLOSE_MS)
    // Shown, it is never closed under the pointer.
    expect(tooltip.current()).toBe(first)
    tooltip.hide()
    vi.advanceTimersByTime(TOOLTIP_IDLE_CLOSE_MS)
    expect(tooltip.current()).toBeNull()
  })

  it('only forgets a window its parent took with it', async () => {
    const tooltip = new TooltipWindow(parent())
    await tooltip.show(request)
    const first = made.at(-1)!
    tooltip.hide()
    first.destroyed = true
    first.destroy = () => {
      throw new Error('Object has been destroyed')
    }
    expect(() => vi.advanceTimersByTime(TOOLTIP_IDLE_CLOSE_MS)).not.toThrow()
    expect(tooltip.current()).toBeNull()
  })

  it('counts nothing before a first tooltip', () => {
    const tooltip = new TooltipWindow(parent())
    tooltip.hide()
    expect(vi.getTimerCount()).toBe(0)
  })

  // Written by the main process, like the page of the drop zones: its own style and its one script, nothing loaded.
  it('gives its page a policy that loads nothing', () => {
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(TOOLTIP_PAGE)?.[1]
    expect(policy).toBe("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
    // Before the style and the script it governs.
    expect(TOOLTIP_PAGE.indexOf('Content-Security-Policy')).toBeLessThan(TOOLTIP_PAGE.indexOf('<style>'))
  })
})

describe('the keys of a shortcut in the tooltip', () => {
  // 11 px bold is small text: the ink of the keys was at 3.78:1 on their ground.
  it('are readable on their ground', () => {
    const key = /\.key \{[^}]*background: (#[0-9a-f]{6});[^}]*[; ]color: (#[0-9a-f]{6});/.exec(TOOLTIP_PAGE)!
    expect(contrastRatio(key[2]!, key[1]!)).toBeGreaterThanOrEqual(AA_TEXT)
  })
})
