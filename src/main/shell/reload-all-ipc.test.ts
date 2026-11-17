// Who decides whether « Actualiser tous les onglets » wakes the sleeping tabs, at the door of the main process (ipc.ts): the buttons of the sidebar
// always do (the maintainer: « si on force l'actualisation dans l'icône… ça actualise en fait toutes les pages »), the command bar leaves it to the
// setting `reloadAllWakes`, as the menu does. The renderer is not trusted: only a real `true` is the button. The run itself: reload-all-run.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { sendFrom } from './ipc-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
const { registerIpc } = await import('./ipc')

const state = createInitialState({ now: 0, newId: () => 'x' })
const store = { get: () => state, subscribe: () => () => {} } as never

/** What the window's reload was asked; the IPC of the window is registered once over it (the fake Electron keeps the first listener of a channel). */
const asked: unknown[][] = []
const reloadAllTabs = (...args: unknown[]) => {
  asked.push(args)
  return Promise.resolve({ reloaded: 0, kept: 0, woken: 0 })
}
registerIpc(fakeBrowser({ reloadAllTabs }).self as never, store, {} as never, new Set([1]))

function windowAsked(): unknown[][] {
  asked.length = 0
  return asked
}

describe('the request of « Actualiser tous les onglets » from the interface', () => {
  it('wakes the sleeping tabs too when it comes from the button of every space, whatever the setting', () => {
    const asked = windowAsked()
    sendFrom(1, Channel.reloadAllTabs, true)
    expect(asked).toEqual([[undefined, true]])
  })

  it('leaves it to the setting when it comes from the command bar, and for anything but a real `true`', () => {
    const asked = windowAsked()
    sendFrom(1, Channel.reloadAllTabs)
    sendFrom(1, Channel.reloadAllTabs, false)
    sendFrom(1, Channel.reloadAllTabs, 'true')
    sendFrom(1, Channel.reloadAllTabs, 1)
    expect(asked).toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined]])
  })

  it('wakes the sleeping tabs of the space on screen for the button of the space', () => {
    const asked = windowAsked()
    sendFrom(1, Channel.reloadSpaceTabs)
    expect(asked).toEqual([[undefined, true, true]])
  })
})
