// The test update channel reaches the interface through the snapshot of the window: Settings › Général draws « Recevoir les versions de test » only
// while the build carries a test address (shell/update-source.ts, `testChannelOfSnapshot`). The build says it, not the profile: a stand-in of the
// window takes its snapshot with the address stubbed as electron-vite would have written it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../blocking', () => ({ blockingService: () => ({ status: () => 'off', subscribe: () => () => {} }) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

// The test channel is a choice of macOS, the system that installs from the addresses of a build (Windows and Linux hide it: update-source.test.ts): the system is set.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => Object.defineProperty(process, 'platform', { value: 'darwin' }))
afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', realPlatform)
})

/** A window whose snapshot can be taken: the parts it reads are given, the rest is a recorder. */
function aWindow() {
  const state = createInitialState({ now: 0, newId: () => 'x' })
  const fake = fakeBrowser({ store: { get: () => state }, mediaPlayers: [], peek: null, sidePanel: null, webPanel: null, toast: null, floatVisible: false, overlayRequest: null, find: null })
  fake.self['saverOfSnapshot'] = () => ({})
  return fake.self
}

describe('what the snapshot says of the test update channel', () => {
  it('is that the build carries one while it does, and nothing for a build made without it', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
    expect(shell['snapshot']!.call(aWindow())).not.toHaveProperty('updateTestChannel')
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', 'https://test.lucium.app/updates/darwin-arm64/feed.json')
    expect(shell['snapshot']!.call(aWindow())).toMatchObject({ updateTestChannel: true })
  })

  it('is not decided by the profile: the setting asked for the test channel changes nothing in a build that has none', () => {
    vi.stubEnv('MAIN_VITE_UPDATE_FEED_TEST', undefined)
    const state = createInitialState({ now: 0, newId: () => 'x' })
    const fake = fakeBrowser({ store: { get: () => ({ ...state, settings: { ...state.settings, updateChannel: 'test' } }) }, mediaPlayers: [], peek: null, sidePanel: null, webPanel: null, toast: null, floatVisible: false, overlayRequest: null, find: null })
    fake.self['saverOfSnapshot'] = () => ({})
    expect(shell['snapshot']!.call(fake.self)).not.toHaveProperty('updateTestChannel')
  })
})
