// The scroll bars setting reaches the interface through the snapshot of the window, and each window publishes when it changes (Browser.start): the lists that
// hide their bar draw it while the system always shows the bars. Run on a stand-in of the window (browser-fake.test-support.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import type { ScrollBarsSource } from './system-scroll-bars'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../blocking', () => ({ blockingService: () => ({ status: () => 'off', subscribe: () => () => {} }) }))
vi.mock('./extension-shims', () => ({ ExtensionShims: class {} }))
const { Browser } = await import('./browser')
const { systemScrollBars } = await import('./system-scroll-bars')
const shell = methodsOf(Browser.prototype)

let value: string = 'Automatic'
let notify: (() => void) | null = null
const source: ScrollBarsSource = { read: () => value, watch: (refresh) => ((notify = refresh), () => undefined) }

afterEach(() => {
  systemScrollBars().stop()
  value = 'Automatic'
})

function aWindow() {
  const state = createInitialState({ now: 0, newId: () => 'x' })
  const fake = fakeBrowser({
    store: { get: () => state, subscribe: () => () => {} },
    mediaPlayers: [],
    peek: null,
    sidePanel: null,
    webPanel: null,
    toast: null,
    floatVisible: false,
    overlayRequest: null,
    find: null,
    group: new Set(),
    scopeGuards: new Map(),
    // What `stop` empties: a stand-in of each, so that it runs to its end.
    pages: new Map(),
    privatePages: new Map(),
    permissionAnswers: new Map(),
    permissionPages: new Map(),
    authAnswers: new Map(),
    reviewAnswers: new Map(),
    dialogAnswers: new Map(),
    leaveAnswers: new Map(),
    passphraseAnswers: new Map(),
    dialogQueue: []
  })
  fake.self['saverOfSnapshot'] = () => ({})
  return fake
}

describe('what the snapshot says of the scroll bars', () => {
  // Guard: the interface draws the bars of its hidden lists only from this field. Without it in the snapshot, the setting would never leave the main process.
  it('is that the system always shows them while it does, and nothing otherwise', () => {
    expect(shell['snapshot']!.call(aWindow().self)).not.toHaveProperty('scrollBarsAlways')
    value = 'Always'
    systemScrollBars().start(source)
    expect(shell['snapshot']!.call(aWindow().self)).toMatchObject({ scrollBarsAlways: true })
  })
})

describe('a window of the application', () => {
  // Guard: a change of the system setting reaches a window that is already open. Without the subscription of `start`, only the windows opened afterwards would know.
  it('publishes when the setting changes, and no more once it is stopped', () => {
    systemScrollBars().start(source)
    const fake = aWindow()
    shell['start']!.call(fake.self)
    const published = () => fake.calls.filter((call) => call.name === 'publish').length
    const before = published()
    value = 'Always'
    notify!()
    expect(published()).toBe(before + 1)
    shell['stop']!.call(fake.self)
    const after = published()
    value = 'Automatic'
    notify!()
    expect(published()).toBe(after)
  })
})
