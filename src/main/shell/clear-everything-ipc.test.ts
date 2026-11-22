// The command bar asks the main process for « Tout effacer » / « Nouvelle identité » (Channel.clearEverything): a kind that is one of the two reaches the
// flow installed by the menus; anything else, and a sender that is not the interface, is refused and starts nothing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { sendFrom } from './ipc-fake.test-support'
import { setClearEverythingStarter, startClearEverything } from './clear-everything'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
const { registerIpc } = await import('./ipc')

afterEach(() => {
  setClearEverythingStarter(null)
  vi.restoreAllMocks()
})

const state = createInitialState({ now: 0, newId: () => 'x' })
const storeOf = { get: () => state, subscribe: () => () => {} } as never
const register = () => registerIpc(fakeBrowser().self as never, storeOf, {} as never, new Set([1]))

describe('Channel.clearEverything', () => {
  it('starts the flow of the kind asked, from the interface', () => {
    const started: string[] = []
    setClearEverythingStarter((kind) => void started.push(kind))
    register()
    sendFrom(1, Channel.clearEverything, 'everything')
    sendFrom(1, Channel.clearEverything, 'identity')
    expect(started).toEqual(['everything', 'identity'])
  })

  it('refuses a kind that is not one of the two', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started: string[] = []
    setClearEverythingStarter((kind) => void started.push(kind))
    register()
    for (const kind of ['all', '', 7, null, undefined, { kind: 'everything' }]) sendFrom(1, Channel.clearEverything, kind)
    expect(started).toEqual([])
    expect(warn).toHaveBeenCalledTimes(6)
  })

  it('ignores a sender that is not the interface', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started: string[] = []
    setClearEverythingStarter((kind) => void started.push(kind))
    register()
    sendFrom(2, Channel.clearEverything, 'everything')
    expect(started).toEqual([])
  })

  it('says so, and starts nothing, when no menu is installed to ask the question', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(startClearEverything('everything')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
