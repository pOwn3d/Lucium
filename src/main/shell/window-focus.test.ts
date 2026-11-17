// The focus of a window, told to its sidebars (window-focus.ts): the video behind a space follows the window, not the sidebar's document, which loses the
// focus each time the user clicks in a page of the window.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Channel } from '@shared/ipc'
import { followWindowFocus } from './window-focus'

class FakeSidebar extends EventEmitter {
  sent: unknown[][] = []
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, ...args: unknown[]): void {
    this.sent.push([channel, ...args])
  }
}

class FakeWindow extends EventEmitter {
  focused = true
  isFocused(): boolean {
    return this.focused
  }
}

describe('the focus of a window, told to its sidebars', () => {
  it('tells each live sidebar when another window comes in front, and when the window is back', () => {
    const win = new FakeWindow()
    const own = new FakeSidebar()
    const floating = new FakeSidebar()
    let live: FakeSidebar | null = null
    followWindowFocus(win, () => [own, live])
    win.emit('blur')
    live = floating
    win.emit('focus')
    expect(own.sent).toEqual([
      [Channel.windowFocus, false],
      [Channel.windowFocus, true]
    ])
    // The floating sidebar is told only while it lives.
    expect(floating.sent).toEqual([[Channel.windowFocus, true]])
  })

  it('tells a sidebar the focus as it stands each time its page has loaded, and nothing to a closed one', () => {
    const win = new FakeWindow()
    const sidebar = new FakeSidebar()
    const tell = followWindowFocus(win, () => [sidebar])
    tell(sidebar)
    sidebar.emit('did-finish-load')
    win.focused = false
    sidebar.emit('did-finish-load')
    expect(sidebar.sent).toEqual([
      [Channel.windowFocus, true],
      [Channel.windowFocus, false]
    ])
    sidebar.destroyed = true
    win.emit('focus')
    expect(sidebar.sent).toHaveLength(2)
  })
})
