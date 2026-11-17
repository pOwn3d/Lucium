// What the task manager is told of the tabs (`listProcesses` of a window, run for real over a fake Electron): the lock of a space hides its tabs from
// the interface, and the task manager is a window of the interface. A locked space destroys its pages, so every one of its tabs is a « sleeping » tab:
// listed by name, they gave the titles the lock promises to hide to whoever opens Fenêtre › Gestionnaire de tâches. A private tab is not named either.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel, type ProcessRow } from '@shared/ipc'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import type { RendererHost } from '@shared/processes'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { invokeFrom } from './ipc-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())

const UI = 1
const LOCKED_TITLE = 'canary-title-behind-the-lock'
const PRIVATE_TITLE = 'canary-title-of-a-private-tab'

/** What the inventory of the renderers was asked: the test reads what it is given, and asks it for the tab of an origin. */
const asked = vi.hoisted(() => ({ tabOnOrigin: null as null | ((origin: string) => string | undefined) }))
vi.mock('./process-meter', () => ({
  processMeter: () => () => [11, 12, 13, 20, 21].map((pid) => ({ pid, type: 'Tab', cpu: 0, memoryKb: pid * 1024 }))
}))
vi.mock('./renderer-hosts', () => ({
  rendererHosts: (input: { group: ReadonlyMap<number, readonly RendererHost[]>; tabOnOrigin: (origin: string) => string | undefined }) => {
    asked.tabOnOrigin = input.tabOnOrigin
    return Promise.resolve(new Map(input.group))
  }
}))

const { registerIpc } = await import('./ipc')
const { setLockService } = await import('../lock-service')

const initial = createInitialState({ now: 0, newId: () => 'x' })
const OPEN = initial.spaces[0]!.id
const tab = (id: string, spaceId: string, title: string, extra: object = {}) => ({ id, spaceId, url: `https://${id}.example/`, title, pinned: false, createdAt: 1, lastActiveAt: 1, ...extra })
const state = {
  ...initial,
  spaces: [{ ...initial.spaces[0]!, name: 'Perso' }, { ...initial.spaces[0]!, id: 'vault', name: 'Coffre' }],
  tabs: [
    tab('open', OPEN, 'Ouvert'),
    tab('asleep', OPEN, 'Endormi'),
    tab('private', OPEN, PRIVATE_TITLE, { private: true }),
    tab('locked-asleep', 'vault', LOCKED_TITLE),
    tab('locked-live', 'vault', LOCKED_TITLE)
  ]
}
const store = { get: () => state, subscribe: () => () => {}, root: () => store, dispatch: () => {} } as never

const browser = fakeBrowser({
  pageProcesses: () => new Map([[11, 'Ouvert'], [12, LOCKED_TITLE], [13, PRIVATE_TITLE]]),
  pageTabs: () => new Map([[11, { tabId: 'open', space: 'Perso' }], [12, { tabId: 'locked-live', space: 'Coffre' }], [13, { tabId: 'private', space: 'Perso' }]]),
  rendererHosts: () =>
    new Map<number, RendererHost[]>([
      [20, [{ kind: 'subframe', tabId: 'locked-live', tabName: LOCKED_TITLE }]],
      [21, [{ kind: 'subframe', tabId: 'private', tabName: PRIVATE_TITLE }]]
    ]),
  sleepingTabs: () => [
    { tabId: 'asleep', name: 'Endormi', space: 'Perso' },
    { tabId: 'locked-asleep', name: LOCKED_TITLE, space: 'Coffre' }
  ]
})

/** The lock as the test sets it: the space « Coffre » locked, or nothing locked. */
const lock = { spaces: [] as string[] }
const lockService = fakeBrowser({
  isAppLocked: () => false,
  lockedSpaces: () => lock.spaces,
  view: () => (lock.spaces.length === 0 ? undefined : { active: true, appLocked: false, lockedSpaces: lock.spaces, guardedSpaces: lock.spaces, touchId: false, retryInMs: 0 })
})
setLockService(lockService.self as never)
registerIpc(browser.self as never, store, {} as never, new Set([UI]))

const rows = async (): Promise<ProcessRow[]> => (await invokeFrom(UI, Channel.listProcesses)) as ProcessRow[]

beforeEach(() => {
  setLanguage('fr')
  lock.spaces = []
})

describe('the rows of the task manager and the lock of a space', () => {
  it('names every tab of an open space, asleep or not (the fixture does carry the titles)', async () => {
    const listed = await rows()
    expect(listed.filter((row) => row.name === LOCKED_TITLE).map((row) => row.tabId).sort()).toEqual(['locked-asleep', 'locked-live'])
    expect(listed.find((row) => row.tabId === 'asleep')).toMatchObject({ name: 'Endormi', space: 'Perso', asleep: true })
    expect(asked.tabOnOrigin!('https://locked-asleep.example')).toBe(LOCKED_TITLE)
  })

  it('gives no title, no tab and no row for a sleeping tab of a locked space', async () => {
    lock.spaces = ['vault']
    const listed = await rows()
    expect(JSON.stringify(listed)).not.toContain(LOCKED_TITLE)
    expect(listed.some((row) => row.tabId === 'locked-asleep' || row.tabId === 'locked-live')).toBe(false)
    // A process still alive for a tab of the locked space keeps its row (the memory is real), under a name that says only that.
    expect(listed.find((row) => row.pid === 12)).toMatchObject({ kind: 'tab', name: 'Onglet d’un espace verrouillé' })
    expect(listed.find((row) => row.pid === 12)?.space).toBeUndefined()
    // The rows of the open space are as before.
    expect(listed.find((row) => row.pid === 11)).toMatchObject({ name: 'Ouvert', tabId: 'open', space: 'Perso' })
    expect(listed.find((row) => row.tabId === 'asleep')).toMatchObject({ name: 'Endormi', asleep: true })
  })

  it('does not name the service worker of a site after a tab of a locked space', async () => {
    lock.spaces = ['vault']
    await rows()
    expect(asked.tabOnOrigin!('https://locked-asleep.example')).toBeUndefined()
    expect(asked.tabOnOrigin!('https://open.example')).toBe('Ouvert')
  })

  it('never names a private tab, whose row and actions stay', async () => {
    const listed = await rows()
    expect(JSON.stringify(listed)).not.toContain(PRIVATE_TITLE)
    expect(listed.find((row) => row.pid === 13)).toMatchObject({ kind: 'tab', name: 'Onglet privé', tabId: 'private' })
    expect(listed.find((row) => row.pid === 21)?.name).toBe(frenchSpaces('Sous-cadre de : Onglet privé'))
  })
})
