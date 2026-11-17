import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { closeOnPageClick, keepInside, keepPopupInWindow, type Box, type ClickablePage, type PopupParts } from './action-popup'

const frame: Box = { x: 100, y: 50, width: 1000, height: 700 }

describe('keepInside', () => {
  it('leaves a box that already fits where it is', () => {
    const box = { x: 300, y: 120, width: 360, height: 400 }
    expect(keepInside(box, frame)).toEqual(box)
  })

  it('pulls back a box that sticks out on the right, as a popup under a button at the right edge does', () => {
    expect(keepInside({ x: 1000, y: 120, width: 360, height: 400 }, frame)).toEqual({ x: 740, y: 120, width: 360, height: 400 })
  })

  it('pulls back a box that sticks out on the left, on the bottom and above the top', () => {
    expect(keepInside({ x: 20, y: 120, width: 360, height: 400 }, frame).x).toBe(100)
    expect(keepInside({ x: 300, y: 600, width: 360, height: 400 }, frame).y).toBe(350)
    expect(keepInside({ x: 300, y: 0, width: 360, height: 400 }, frame).y).toBe(50)
  })

  it('keeps the size, whatever it moves', () => {
    const moved = keepInside({ x: 5000, y: 5000, width: 360, height: 400 }, frame)
    expect([moved.width, moved.height]).toEqual([360, 400])
  })

  it('sticks a box larger than the frame to the top left corner instead of centring it off screen', () => {
    expect(keepInside({ x: 700, y: 300, width: 1400, height: 900 }, frame)).toEqual({ x: 100, y: 50, width: 1400, height: 900 })
  })
})

describe('keepPopupInWindow', () => {
  const fake = (popupBounds: Box, parentBounds: Box = frame, state: { popupGone?: boolean; parentGone?: boolean } = {}) => {
    const set: Box[] = []
    const popup: PopupParts = {
      browserWindow: { isDestroyed: () => !!state.popupGone, getBounds: () => popupBounds, setBounds: (b) => void set.push(b) },
      parent: { isDestroyed: () => !!state.parentGone, getBounds: () => parentBounds }
    }
    return { popup, set }
  }

  it('moves a popup that leaves the window, and says nothing about one that fits', () => {
    const out = fake({ x: 1000, y: 120, width: 360, height: 400 })
    keepPopupInWindow(out.popup)
    expect(out.set).toEqual([{ x: 740, y: 120, width: 360, height: 400 }])
    const inside = fake({ x: 300, y: 120, width: 360, height: 400 })
    keepPopupInWindow(inside.popup)
    expect(inside.set).toEqual([])
  })

  it('does nothing when the popup, its window or the parent is already gone', () => {
    for (const state of [{ popupGone: true }, { parentGone: true }]) {
      const out = fake({ x: 1000, y: 120, width: 360, height: 400 }, frame, state)
      keepPopupInWindow(out.popup)
      expect(out.set, JSON.stringify(state)).toEqual([])
    }
    expect(() => keepPopupInWindow({})).not.toThrow()
  })
})

describe('closeOnPageClick', () => {
  class FakePage extends EventEmitter implements ClickablePage {
    gone = false
    isDestroyed(): boolean {
      return this.gone
    }
    listening(): number {
      return this.listenerCount('before-mouse-event')
    }
  }
  const fakePopup = () => {
    const win = Object.assign(new EventEmitter(), { gone: false, isDestroyed: () => win.gone })
    const popup = {
      destroyed: false,
      browserWindow: win,
      destroy: () => {
        if (popup.destroyed) return
        popup.destroyed = true
        win.gone = true
        // As BrowserWindow.destroy() does: the window says it closed.
        win.emit('closed')
      }
    }
    return popup
  }

  it('closes the popup on a press of the mouse in a page, not on a move', () => {
    const page = new FakePage()
    const popup = fakePopup()
    closeOnPageClick(popup, [page])
    page.emit('before-mouse-event', {}, { type: 'mouseMove' })
    expect(popup.destroyed).toBe(false)
    page.emit('before-mouse-event', {}, { type: 'mouseDown' })
    expect(popup.destroyed).toBe(true)
  })

  it('takes its listeners off every page when the popup closes, with no click in them', () => {
    const pages = [new FakePage(), new FakePage()]
    // Popups opened and closed from the keyboard: no event ever reaches the pages.
    for (let i = 0; i < 5; i++) {
      const popup = fakePopup()
      closeOnPageClick(popup, pages)
      expect(pages.map((page) => page.listening())).toEqual([1, 1])
      popup.destroy()
    }
    expect(pages.map((page) => page.listening())).toEqual([0, 0])
  })

  it('leaves a page that went first alone, and listens to nothing for a popup already gone', () => {
    const page = new FakePage()
    const gone = new FakePage()
    const popup = fakePopup()
    closeOnPageClick(popup, [page, gone])
    gone.gone = true
    expect(() => popup.destroy()).not.toThrow()
    expect(page.listening()).toBe(0)
    const closed = fakePopup()
    closed.destroy()
    closeOnPageClick(closed, [page])
    expect(page.listening()).toBe(0)
  })
})
