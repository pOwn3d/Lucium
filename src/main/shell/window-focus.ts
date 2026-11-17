// The focus of a window, told to the sidebars that draw it (the window's own page, and the floating sidebar while it lives). Their document cannot tell:
// a page of the window takes the keyboard from the sidebar, and the sidebar's document loses the focus, while the window keeps it. The video behind a space
// stops while another window or application is in front (unless its space keeps it playing), not each time the user clicks in a page.

import { Channel } from '@shared/ipc'

/** What is used of a sidebar's web contents. */
export interface FocusSidebar {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  on(event: 'did-finish-load', listener: () => void): unknown
}

/** What is used of the window. */
export interface FocusWindow {
  isFocused(): boolean
  on(event: 'focus' | 'blur', listener: () => void): unknown
}

/**
 * Tells the sidebars of `win` each change of its focus, and returns how to add one: a sidebar is told the focus again each time its page has loaded (a
 * message sent before the load is lost, and a reload starts the interface again). `sidebars` lists the live ones when the focus changes.
 */
export function followWindowFocus(win: FocusWindow, sidebars: () => readonly (FocusSidebar | null | undefined)[]): (sidebar: FocusSidebar) => void {
  const tell = (sidebar: FocusSidebar | null | undefined, focused: boolean) => {
    if (sidebar && !sidebar.isDestroyed()) sidebar.send(Channel.windowFocus, focused)
  }
  win.on('focus', () => {
    for (const sidebar of sidebars()) tell(sidebar, true)
  })
  win.on('blur', () => {
    for (const sidebar of sidebars()) tell(sidebar, false)
  })
  return (sidebar) => void sidebar.on('did-finish-load', () => tell(sidebar, win.isFocused()))
}
