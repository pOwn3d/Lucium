// The button « Contraste de la page » at the door of the main process (ipc.ts): the interface may ask for its menu by the kind `readable` and a tab id, like the other
// menus of the shell, and for no kind that is not a menu; and may say that the button was clicked, by a tab id. What the menu holds: readable-menu.test.ts;
// what a click does: readable-toggle.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { Channel, type LuciumApi } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { ipcHost, sendFrom } from './ipc-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))
const shown: unknown[] = []
vi.mock('./context-menus', () => ({ showMenu: (target: unknown) => void shown.push(target), moveTabsToSpace: () => undefined }))
const toggled: unknown[] = []
vi.mock('./page-commands', () => ({ toggleReadableSite: (_browser: unknown, _store: unknown, id: unknown) => void toggled.push(id) }))
const { registerIpc } = await import('./ipc')

const state = createInitialState({ now: 0, newId: () => 'x' })
const store = { get: () => state, subscribe: () => () => {} } as never
let locked: string[] = []
registerIpc(fakeBrowser({ namesLockedTarget: (target: { id: string }) => locked.includes(target.id) }).self as never, store, {} as never, new Set([1]))

describe('the request for the menu of the button « Contraste de la page »', () => {
  it('is answered for a tab id, as the menus of the sidebar and of the split view are', () => {
    shown.length = 0
    sendFrom(1, Channel.showMenu, { kind: 'readable', id: 'tab-1' })
    expect(shown).toEqual([{ kind: 'readable', id: 'tab-1' }])
  })

  it('is refused without a tab id, and for a kind that is not a menu', () => {
    shown.length = 0
    for (const target of [{ kind: 'readable' }, { kind: 'readable', id: 7 }, { kind: 'nothing', id: 'tab-1' }, { id: 'tab-1' }, null]) sendFrom(1, Channel.showMenu, target)
    expect(shown).toEqual([])
  })

  it('is not answered for a tab a lock hides', () => {
    shown.length = 0
    locked = ['tab-1']
    sendFrom(1, Channel.showMenu, { kind: 'readable', id: 'tab-1' })
    locked = []
    expect(shown).toEqual([])
  })
})

describe('the click on the button « Contraste de la page »', () => {
  it('is handed to the main process with the tab id', () => {
    toggled.length = 0
    sendFrom(1, Channel.toggleReadable, 'tab-1')
    expect(toggled).toEqual(['tab-1'])
  })

  it('is refused without a tab id: the interface’s word is not trusted', () => {
    toggled.length = 0
    for (const id of [undefined, null, 7, {}, ['tab-1']]) sendFrom(1, Channel.toggleReadable, id)
    expect(toggled).toEqual([])
  })

  it('is not answered for a tab a lock hides', () => {
    toggled.length = 0
    locked = ['tab-1']
    sendFrom(1, Channel.toggleReadable, 'tab-1')
    locked = []
    expect(toggled).toEqual([])
  })
})

// The bridge of the interface (the preload script) sends the two requests of the button on their own channels, with the tab id alone.
describe('the wiring of the button « Contraste de la page » in the bridge of the interface', () => {
  it('sends the menu and the click on their own channels', async () => {
    vi.stubGlobal('location', { search: '' })
    try {
      await import('../../preload/index')
      const api = ipcHost.exposed.get('lucium') as LuciumApi
      ipcHost.sent.length = 0
      api.showMenu({ kind: 'readable', id: 'tab-1' })
      api.toggleReadable('tab-1')
      expect(ipcHost.sent).toEqual([
        { kind: 'send', channel: Channel.showMenu, args: [{ kind: 'readable', id: 'tab-1' }] },
        { kind: 'send', channel: Channel.toggleReadable, args: ['tab-1'] }
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
