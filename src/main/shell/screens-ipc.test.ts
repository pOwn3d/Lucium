import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import type { Rect } from '@shared/panel-scale'
import { electronDisplays, type DisplayData, type ScreenApi } from './panel-scaling'

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null }, screen: {} }))
const { panelScreenViews, registerScreensIpc } = await import('./screens-ipc')

const data = (label: string, internal: boolean, width: number, height: number, scaleFactor: number, x: number): DisplayData => ({
  label,
  internal,
  scaleFactor,
  size: { width, height },
  bounds: { x, y: 0, width, height },
  workArea: { x, y: 25, width, height: height - 25 }
})
const ULTRAWIDE = data('LG UltraWide', false, 3440, 1440, 1, 0)
const LAPTOP = data('Built-in Retina Display', true, 1512, 982, 2, 3440)

const displays = (list: DisplayData[]) => {
  const api: ScreenApi = {
    getDisplayMatching: (bounds: Rect) => list.find((d) => bounds.x + bounds.width / 2 >= d.bounds.x && bounds.x + bounds.width / 2 < d.bounds.x + d.bounds.width) ?? list[0]!,
    getPrimaryDisplay: () => list[0]!,
    getAllDisplays: () => list,
    on: () => undefined,
    removeListener: () => undefined
  }
  return electronDisplays(api)
}

describe('the screens the Settings window is told of', () => {
  it('lists every connected screen with its size, density and name, the one the asking window is on marked', () => {
    const views = panelScreenViews(displays([ULTRAWIDE, LAPTOP]), { x: 3600, y: 100, width: 900, height: 700 }, null)
    expect(views.map((view) => [view.key, view.width, view.height, view.scaleFactor, view.internal, view.label, view.current])).toEqual([
      ['LG UltraWide|3440x1440@1', 3440, 1440, 1, false, 'LG UltraWide', false],
      ['built-in|1512x982@2', 1512, 982, 2, true, '', true]
    ])
  })

  it('gives the main window in the coordinates of the screen it is on, and none for the others', () => {
    const views = panelScreenViews(displays([ULTRAWIDE, LAPTOP]), { x: 100, y: 100, width: 10, height: 10 }, { x: 4000, y: 120, width: 1200, height: 800 })
    expect(views[0]!.window).toBeNull()
    expect(views[1]!.window).toEqual({ x: 560, y: 120, width: 1200, height: 800 })
    expect(views[0]!.current).toBe(true)
  })

  it('goes by the middle of the window: one straddling two screens belongs to the one it is mostly on', () => {
    const views = panelScreenViews(displays([ULTRAWIDE, LAPTOP]), null, { x: 2700, y: 100, width: 1200, height: 800 })
    expect(views[0]!.window).toEqual({ x: 2700, y: 100, width: 1200, height: 800 })
    expect(views[1]!.window).toBeNull()
  })

  it('gives the main window to no screen when its middle is on none of them (a window left far below the screens)', () => {
    const views = panelScreenViews(displays([ULTRAWIDE, LAPTOP]), null, { x: 100, y: 5000, width: 1200, height: 800 })
    expect(views.map((view) => view.window)).toEqual([null, null])
  })

  it('has no current screen when the asking window is not known, and no window when the main window is gone', () => {
    const views = panelScreenViews(displays([ULTRAWIDE, LAPTOP]), null, null)
    expect(views.every((view) => !view.current && view.window === null)).toBe(true)
  })

  it('leaves out a display that gives no size', () => {
    expect(panelScreenViews(displays([ULTRAWIDE, { ...LAPTOP, size: { width: 0, height: 0 } }]), null, null)).toHaveLength(1)
  })
})

describe('the channel', () => {
  it('answers nothing to a sender that is not a page of the interface (the guard says no), and does not read the screens then', () => {
    const handlers = new Map<string, (event: { sender: unknown }) => unknown>()
    registerScreensIpc({ handle: (channel: string, handler: (event: { sender: unknown }) => unknown) => void handlers.set(channel, handler) } as never, () => false, {} as never)
    expect(handlers.get(Channel.panelScreens)!({ sender: {} })).toEqual([])
  })
})
