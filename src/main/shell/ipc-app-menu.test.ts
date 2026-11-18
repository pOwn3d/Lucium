// The button ☰ of the toolbar at the door of the main process (ipc.ts): the interface of a window may ask for the menu of the application at a point, and
// nobody else may. What the browser does with the point (reads it again, scales it, opens the menu): layout-calls.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { Channel, type LuciumApi } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { ipcHost, sendFrom } from './ipc-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))
const { registerIpc } = await import('./ipc')

const state = createInitialState({ now: 0, newId: () => 'x' })
const store = { get: () => state, subscribe: () => () => {} } as never
const browser = fakeBrowser()
registerIpc(browser.self as never, store, {} as never, new Set([1]))

const asked = () => browser.calls.filter((call) => call.name === 'popupAppMenu')

describe('the request for the menu of the application', () => {
  it('is handed to the browser of the window with the point the interface named', () => {
    browser.calls.length = 0
    sendFrom(1, Channel.showAppMenu, { x: 14, y: 42 })
    expect(asked().map((call) => call.args)).toEqual([[{ x: 14, y: 42 }]])
  })

  it('is ignored from a page that is no surface of ours', () => {
    browser.calls.length = 0
    sendFrom(99, Channel.showAppMenu, { x: 14, y: 42 })
    expect(asked()).toEqual([])
  })
})

// The bridge of the interface (the preload script) sends it on its own channel, with the point alone.
describe('the wiring of the button ☰ in the bridge of the interface', () => {
  it('sends the request on its own channel', async () => {
    vi.stubGlobal('location', { search: '' })
    try {
      await import('../../preload/index')
      const api = ipcHost.exposed.get('lucium') as LuciumApi
      ipcHost.sent.length = 0
      api.showAppMenu({ x: 14, y: 42 })
      expect(ipcHost.sent).toEqual([{ kind: 'send', channel: Channel.showAppMenu, args: [{ x: 14, y: 42 }] }])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
