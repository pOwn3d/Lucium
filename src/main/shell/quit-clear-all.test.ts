// « Effacer à la fermeture » in « tous les sites » mode: what Browser.clearSitesOnQuit hands the engine. The marker of a cut erasure is tested with the
// quit itself (quit-flow.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({ autoUpdater: {}, BrowserWindow: {}, dialog: {}, shell: {} }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : {}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

afterEach(() => vi.restoreAllMocks())

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
function stateOf(settings: Partial<SidebarState['settings']>): SidebarState {
  const start = createInitialState(ctx)
  const first = start.spaces[0]!
  return { ...start, spaces: [first, { ...first, id: 'work-space', profileId: 'travail' }], settings: { ...start.settings, siteDataClearOnCloseEnabled: true, siteDataClearOnQuit: true, siteDataClearOnQuitAll: true, siteDataClearOnClose: [], ...settings } }
}

function quitting(state: SidebarState, clearProfileData: (id: string, keep: readonly string[]) => Promise<void>) {
  const toasts: string[] = []
  const fake = fakeBrowser({ store: { get: () => state }, clearTail: Promise.resolve(), isPrivate: () => false, engine: { clearProfileData }, wipeProfileOnQuit: shell['wipeProfileOnQuit'], runClearJob: shell['runClearJob'], tellClearFailure: (message: string) => void toasts.push(message), showToast: (message: string) => void toasts.push(message) })
  return { fake, toasts }
}

describe('Browser.clearSitesOnQuit in « tous les sites » mode', () => {
  it('wipes every profile the spaces use, sparing the sites of the list, and keeps the history alone', async () => {
    const seen: Array<{ id: string; keep: readonly string[] }> = []
    const { fake } = quitting(stateOf({ clearAllKeepHosts: ['exemple.org'] }), async (id, keep) => void seen.push({ id, keep }))
    expect(await shell['clearSitesOnQuit']!.call(fake.self)).toEqual([])
    // Mutation: dropping the list from the engine call (or the mode) makes these fail.
    expect(seen).toEqual([{ id: 'default', keep: ['exemple.org'] }, { id: 'travail', keep: ['exemple.org'] }])
  })

  it('names the profile that kept something, tells the user, and still wipes the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: string[] = []
    const { fake, toasts } = quitting(stateOf({}), async (id) => (id === 'default' ? Promise.reject(new Error('busy')) : void seen.push(id)))
    expect(await shell['clearSitesOnQuit']!.call(fake.self)).toEqual(['profile:default'])
    expect(seen).toEqual(['travail'])
    expect(error).toHaveBeenCalledTimes(1)
    expect(toasts).toEqual(['Les données de tous les sites n’ont pas pu être entièrement effacées à la fermeture.'])
  })

  it('wipes nothing in list mode: the listed sites go through their own runs', async () => {
    const wiped = vi.fn(async () => undefined)
    const { fake } = quitting(stateOf({ siteDataClearOnQuitAll: false }), wiped)
    await (shell['clearSitesOnQuit']!.call(fake.self) as Promise<string[]>).catch(() => undefined)
    expect(wiped).not.toHaveBeenCalled()
  })
})
