// Where the tooltip capsule opens: right of the point by default (left of it against the right edge of the screen), and left of it when the interface asks
// (`side: 'left'`: a tile of a sidebar docked at the right of the window, whose bubble falls on the page rather than off the window). Over a fake window.

import { describe, expect, it, vi } from 'vitest'
import { TOOLTIP } from '@shared/ipc'

const placed = vi.hoisted(() => [] as Array<{ x: number; y: number; width: number; height: number }>)
vi.mock('electron', () => {
  class FakeWindow {
    readonly webContents = { setWindowOpenHandler: () => undefined, on: () => undefined, executeJavaScript: async () => 120 }
    isDestroyed = (): boolean => false
    isMinimized = (): boolean => false
    isVisible = (): boolean => true
    setIgnoreMouseEvents = (): void => undefined
    loadURL = async (): Promise<void> => undefined
    getContentBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 })
    setBounds = (bounds: { x: number; y: number; width: number; height: number }): void => void placed.push(bounds)
    showInactive = (): void => undefined
    hide = (): void => undefined
    destroy = (): void => undefined
  }
  return { BrowserWindow: FakeWindow, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }) } }
})

const { TooltipWindow } = await import('./tooltip')
const { BrowserWindow } = await import('electron')

/** Where the capsule's window goes for a request at (1150, 60) in a window of 1200 px, the capsule 120 px wide. */
async function placedFor(side?: 'left'): Promise<number> {
  placed.length = 0
  await new TooltipWindow(new BrowserWindow() as never).show({ text: 'WhatsApp · 12 non lus', x: 1150, y: 60, ...(side ? { side } : {}) })
  return placed[0]!.x
}

describe('the side the tooltip opens on', () => {
  it('opens right of the point by default, and left of it when asked', async () => {
    expect(await placedFor()).toBe(1150 + TOOLTIP.offsetX - TOOLTIP.shadow)
    expect(await placedFor('left')).toBe(1150 - TOOLTIP.offsetX - 120 - TOOLTIP.shadow)
  })
})
