// The popup of an extension's toolbar button. The library places it from the button alone (its right edge or its left edge on
// the button's), so a button near an edge of the window sends a wide popup out of the window; this keeps it inside.

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** `box` moved the shortest way so that it lies inside `frame`; a box larger than the frame sticks to the frame's top left corner. */
export function keepInside(box: Box, frame: Box): Box {
  const x = Math.max(frame.x, Math.min(box.x, frame.x + frame.width - box.width))
  const y = Math.max(frame.y, Math.min(box.y, frame.y + frame.height - box.height))
  return { ...box, x, y }
}

/** The two windows involved, as the library's popup view exposes them. */
export interface PopupParts {
  browserWindow?: { isDestroyed(): boolean; getBounds(): Box; setBounds(bounds: Box): void }
  parent?: { isDestroyed(): boolean; getBounds(): Box }
}

/** Puts the popup back inside the window it hangs from; does nothing when either window is gone or it already fits. */
export function keepPopupInWindow(popup: PopupParts): void {
  const win = popup.browserWindow
  const parent = popup.parent
  if (!win || !parent || win.isDestroyed() || parent.isDestroyed()) return
  const current = win.getBounds()
  const next = keepInside(current, parent.getBounds())
  if (next.x !== current.x || next.y !== current.y) win.setBounds(next)
}

/** A page of a tab, as far as a click in it matters to a popup. */
export interface ClickablePage {
  isDestroyed(): boolean
  on(event: 'before-mouse-event', listener: (event: unknown, mouse: { type: string }) => void): unknown
  off(event: 'before-mouse-event', listener: (event: unknown, mouse: { type: string }) => void): unknown
}

/** The popup, as far as closing it goes: the library's view and the window it shows in. */
export interface ClosablePopup {
  readonly destroyed: boolean
  destroy(): void
  browserWindow?: { isDestroyed(): boolean; once(event: 'closed', listener: () => void): unknown }
}

/**
 * A click in one of `pages` closes the popup (see the engine for why the library does not always do it). The listeners go
 * with the popup, however it closes: left on the pages, every popup opened from the keyboard (no click to take them away) added one to
 * each page of the window for as long as the page lived.
 */
export function closeOnPageClick(popup: ClosablePopup, pages: Iterable<ClickablePage>): void {
  const win = popup.browserWindow
  if (popup.destroyed || !win || win.isDestroyed()) return
  const listening: Array<{ page: ClickablePage; onMouse: (event: unknown, mouse: { type: string }) => void }> = []
  const stop = (): void => {
    for (const { page, onMouse } of listening.splice(0)) if (!page.isDestroyed()) page.off('before-mouse-event', onMouse)
  }
  for (const page of pages) {
    const onMouse = (_event: unknown, mouse: { type: string }): void => {
      if (popup.destroyed) return stop()
      if (mouse.type === 'mouseDown') popup.destroy()
    }
    page.on('before-mouse-event', onMouse)
    listening.push({ page, onMouse })
  }
  win.once('closed', stop)
}
