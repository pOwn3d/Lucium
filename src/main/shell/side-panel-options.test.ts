import { describe, expect, it, vi } from 'vitest'
import { applyOptions, type PanelConfig } from '@shared/sidepanel'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// What `chrome.sidePanel.setOptions` does to the panel docked in a window. The methods of the window run on a stand-in (browser-fake.test-support.ts):
// no Electron, no window. Closing and opening a panel are recorded, not run.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const DOCKED = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

/**
 * A window whose tab on screen is `shown`, with the panel of DOCKED open: the agent's walk of the engine suite, which opens its panel for the tab
 * 'probe' (options set for that tab only) while its own options page, opened just before, is on screen.
 */
function window(shown: string) {
  const initial = createInitialState({ now: 0, newId: () => 'x' })
  const space = { ...initial.spaces[0]!, id: 'sp', profileId: 'default' }
  const tab = (id: string) => ({ ...initial.tabs[0]!, id, spaceId: 'sp', url: `https://${id}.example/` })
  const state = { ...initial, spaces: [space], activeSpaceId: 'sp', tabs: [tab('probe'), tab('options'), tab('elsewhere')], activeTabBySpace: { sp: shown } }
  const panelConfigs = new Map<string, PanelConfig>([[DOCKED, applyOptions(undefined, 'probe', { path: 'panel.html?tabId=7', enabled: true })]])
  const fake = fakeBrowser({
    store: { get: () => state },
    leader: { panelConfigs },
    sidePanel: { extensionId: DOCKED, name: 'Agent', path: 'panel.html?tabId=7', page: { destroy: vi.fn() }, profileId: 'default' },
    engine: { listExtensions: () => [] },
    resolveSidePanel(this: unknown, extensionId: string, tabKey: string | undefined) {
      return shell['resolveSidePanel']!.call(this, extensionId, tabKey)
    },
    profileForPanel: () => 'default',
    reconcileSidePanel(this: unknown, set?: unknown) {
      return shell['reconcileSidePanel']!.call(this, set)
    }
  })
  fake.self['group'] = new Set([fake.self])
  const setOptions = (extensionId: string, tabKey: string | undefined, patch: { path?: string; enabled?: boolean }) => shell['setSidePanelOptions']!.call(fake.self, extensionId, tabKey, patch)
  const touched = () => fake.names().filter((name) => name === 'closeSidePanel' || name === 'openSidePanel')
  return { fake, setOptions, touched }
}

describe('chrome.sidePanel.setOptions and the panel docked in a window', () => {
  it('leaves the panel of an extension open when another extension sets its own options (a worker that starts again sets them on its first line)', () => {
    const { setOptions, touched } = window('options')
    setOptions(OTHER, undefined, { path: 'panel.html', enabled: true })
    setOptions(OTHER, 'options', { enabled: false })
    expect(touched()).toEqual([])
  })

  it('leaves it open when its own extension sets options for a tab that is not on screen', () => {
    const { setOptions, touched } = window('options')
    setOptions(DOCKED, 'elsewhere', { path: 'other.html', enabled: true })
    expect(touched()).toEqual([])
  })

  it('still follows the options of its own extension for the tab on screen, and for every tab', () => {
    const shownOff = window('probe')
    shownOff.setOptions(DOCKED, 'probe', { enabled: false })
    expect(shownOff.touched()).toEqual(['closeSidePanel'])
    const allTabs = window('options')
    allTabs.setOptions(DOCKED, undefined, { path: 'everywhere.html', enabled: true })
    expect(allTabs.fake.calls.filter((call) => call.name === 'openSidePanel').map((call) => call.args)).toEqual([[DOCKED, 'options']])
  })

  it('still closes the panel when the user moves to a tab that has none', () => {
    const { fake, touched } = window('options')
    shell['reconcileSidePanel']!.call(fake.self)
    expect(touched()).toEqual(['closeSidePanel'])
  })
})
