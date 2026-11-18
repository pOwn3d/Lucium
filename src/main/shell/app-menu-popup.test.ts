import { describe, expect, it, vi } from 'vitest'
import { popupApplicationMenu } from './app-menu-popup'

describe('the menu of the application as a popup', () => {
  it('opens the installed menu on the window, at the point given', () => {
    const popup = vi.fn()
    const win = { id: 7 }
    expect(popupApplicationMenu({ popup }, win, { x: 12, y: 42 })).toBe(true)
    expect(popup).toHaveBeenCalledExactlyOnceWith({ window: win, x: 12, y: 42 })
  })

  it('opens nothing, and says so, when no menu is installed', () => {
    expect(popupApplicationMenu(null, {}, { x: 0, y: 0 })).toBe(false)
  })
})
