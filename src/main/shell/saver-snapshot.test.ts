// The battery saver reaches the interface through the snapshot of the window: the sidebar pauses the video behind a space while the mode is on
// (shared/space-media.ts `backgroundVideoOnView`). The mode is the application's, one for all windows (shell/battery-saver.ts); the snapshot says it while
// it is on and says nothing otherwise. Run on a stand-in of the window (browser-fake.test-support.ts), against the real switch fed by a fake power source.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import type { PowerSource } from './battery-saver'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../blocking', () => ({ blockingService: () => ({ status: () => 'off', subscribe: () => () => {} }) }))
const { Browser } = await import('./browser')
const { batterySaver } = await import('./battery-saver')
const shell = methodsOf(Browser.prototype)

const mains: PowerSource = { onBattery: () => false, percent: async () => null, watch: () => () => {} }

/** The switch of the application on or off, as the setting and the menu entry « Mode économie de batterie » do. */
function setSaver(on: boolean): void {
  batterySaver().configure(true)
  batterySaver().setAsked(on)
}

let restoreSource: (() => void) | null = null
afterEach(() => {
  batterySaver().configure(false)
  restoreSource?.()
  restoreSource = null
})

/** A window whose snapshot can be taken: the parts it reads are given, the rest is a recorder. */
function aWindow() {
  const state = createInitialState({ now: 0, newId: () => 'x' })
  const fake = fakeBrowser({ store: { get: () => state }, mediaPlayers: [], peek: null, sidePanel: null, webPanel: null, toast: null, floatVisible: false, overlayRequest: null, find: null })
  fake.self['saverOfSnapshot'] = () => shell['saverOfSnapshot']!.call(fake.self)
  return fake.self
}

describe('what the snapshot says of the battery saver', () => {
  it('is that it is on while it is, and nothing while it is off', () => {
    restoreSource = batterySaver().useSource(mains)
    expect(shell['saverOfSnapshot']!.call(aWindow())).toEqual({})
    setSaver(true)
    expect(shell['saverOfSnapshot']!.call(aWindow())).toEqual({ batterySaverOn: true })
    setSaver(false)
    expect(shell['saverOfSnapshot']!.call(aWindow())).toEqual({})
  })

  it('is in the snapshot of the window', () => {
    restoreSource = batterySaver().useSource(mains)
    expect(shell['snapshot']!.call(aWindow())).not.toHaveProperty('batterySaverOn')
    setSaver(true)
    expect(shell['snapshot']!.call(aWindow())).toMatchObject({ batterySaverOn: true })
  })

  it('is published to the windows each time the mode comes on or goes off', () => {
    const publish = vi.fn()
    const self = Object.assign(aWindow(), { publish, pages: new Map() })
    restoreSource = batterySaver().useSource(mains)
    batterySaver().configure(true)
    const stop = batterySaver().subscribe(() => shell['applySaver']!.call(self))
    batterySaver().setAsked(true)
    batterySaver().setAsked(false)
    stop()
    expect(publish).toHaveBeenCalledTimes(2)
  })
})
