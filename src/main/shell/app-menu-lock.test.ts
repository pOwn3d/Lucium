// The menu bar and the menu of the Dock while the application is locked, as `installAppMenus` really installs them (over a fake Electron that keeps
// what it is given): locked, the Dock offers no window and the menu bar nothing that shows or changes what is hidden; a lock that starts or ends
// rebuilds both. Before, a test only read that the two lines were in the source.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { defaultSettings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'

interface Item {
  label?: string
  role?: string
  enabled?: boolean
  toolTip?: string
  click?: () => void
  submenu?: Item[]
}

/** What Electron was last given: the application menu and the menu of the Dock, as their templates. */
const installed = vi.hoisted(() => ({ menu: null as Item[] | null, dock: null as Item[] | null }))

vi.mock('electron', async () => {
  const base = (await import('./ipc-fake.test-support')).fakeElectron() as Record<string, unknown>
  const own: Record<string, unknown> = {
    Menu: { buildFromTemplate: (template: Item[]) => template, setApplicationMenu: (menu: Item[]) => void (installed.menu = menu) },
    app: {
      dock: { setMenu: (menu: Item[]) => void (installed.dock = menu) },
      getLocale: () => 'fr-FR',
      getVersion: () => '0.3.0',
      getName: () => 'Lucium',
      getPath: () => '/tmp/lucium-test',
      isDefaultProtocolClient: () => false,
      isPackaged: false,
      setAboutPanelOptions: () => {}
    }
  }
  return new Proxy(own, { has: (target, prop) => prop in target || prop in base, get: (target, prop: string) => (prop in target ? target[prop] : base[prop]) })
})
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))

const { installAppMenus } = await import('./app-menu-wiring')
const { lockedMenuTemplate } = await import('./lock-menu')

/** The application with one window, and a lock the test turns. */
function application(startsLocked = false) {
  const initial = createInitialState({ now: 0, newId: () => 'x' })
  // One tab was archived in the space on screen: « Rouvrir le dernier onglet fermé » has something to bring back, unless the lock hides it.
  const state = { ...initial, settings: defaultSettings(), archive: [{ id: 'closed', spaceId: initial.activeSpaceId, url: 'https://secret.example/', title: 'Secret', archivedAt: 1 }] }
  const lockState = { appLocked: startsLocked, active: true, spaces: [] as string[] }
  const opened: string[] = []
  const stateListeners: Array<() => void> = []
  const store = { get: () => state, subscribe: (listener: () => void) => (stateListeners.push(listener), () => {}) }
  const browser = new Proxy({ menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) })
  const target = { id: 'main', kind: 'main', win: { isDestroyed: () => false, isAlwaysOnTop: () => false }, store, browser }
  const windowManager = {
    focused: () => target,
    isMainAway: () => false,
    namesKey: () => '',
    closedCount: () => 0,
    canReopenClosed: () => false,
    reopenClosed: () => null,
    entries: () => [],
    onChange: () => () => {},
    newWindow: () => void opened.push('window'),
    openPrivate: () => void opened.push('private window')
  }
  const lock = {
    isAppLocked: () => lockState.appLocked,
    isActive: () => lockState.active,
    lockedSpaces: () => lockState.spaces,
    view: () => ({ active: true, appLocked: lockState.appLocked, lockedSpaces: lockState.spaces, guardedSpaces: lockState.spaces, touchId: false, retryInMs: 0 }),
    lockNow: () => {}
  }
  const little = { count: () => 0, onCountChange: () => {}, showAll: () => {}, closeAll: () => {} }
  const engine = { listExtensions: () => [], onExtensionsChanged: () => {}, info: () => ({ name: 'Electron', version: '45', chromium: '150' }) }
  const { refreshMenu } = installAppMenus({ engine, lock, little, windowManager, store, browser, annotateShare: null, pageAnnotate: null, aboutWindow: { open: () => {} }, taskManager: { open: () => {} }, sessionStart: 0 } as never)
  return { lockState, refreshMenu, opened, state }
}

/** Every label of a menu, its submenus included. */
const labels = (items: Item[] | null): string[] => (items ?? []).flatMap((item) => [...(item.label ? [item.label] : []), ...labels(item.submenu ?? null)])

const realPlatform = process.platform
beforeEach(() => {
  installed.menu = null
  installed.dock = null
  // The Dock is macOS': the test plays it on any machine.
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})
afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }))

describe('the menu of the Dock', () => {
  it('offers a new window and a new private window while the application is not locked, and they open', () => {
    const app = application()
    expect(labels(installed.dock)).toEqual(expect.arrayContaining([t('menu.nouvelle-fenetre'), t('menu.nouvelle-fenetre-privee')]))
    installed.dock!.find((item) => item.label === t('menu.nouvelle-fenetre'))!.click!()
    expect(app.opened).toEqual(['window'])
  })

  it('offers nothing while the application is locked: a new window would be a way round the lock screen', () => {
    const app = application()
    app.lockState.appLocked = true
    app.refreshMenu()
    expect(installed.dock).toEqual([])
    // Unlocked, the entries are back.
    app.lockState.appLocked = false
    app.refreshMenu()
    expect(labels(installed.dock)).toContain(t('menu.nouvelle-fenetre'))
  })

  it('is empty from the start for an application that starts locked', () => {
    application(true)
    expect(installed.dock).toEqual([])
    expect(installed.menu).toEqual(lockedMenuTemplate())
  })
})

describe('the menu bar', () => {
  it('opens a window, or brings the main one back, through newWindow: ⌘N (File › New Window) and the private window', () => {
    const app = application()
    const entry = (label: string): Item => (installed.menu ?? []).flatMap((item) => item.submenu ?? []).find((item) => item.label === label)!
    entry(t('menu.nouvelle-fenetre')).click!()
    entry(t('menu.nouvelle-fenetre-privee')).click!()
    expect(app.opened).toEqual(['window', 'private window'])
  })

  it('is the whole menu while the application is not locked', () => {
    application()
    expect(labels(installed.menu)).toEqual(expect.arrayContaining([t('menu.nouvelle-fenetre'), t('menu.nouvelle-fenetre-privee')]))
    expect(labels(installed.menu).length).toBeGreaterThan(60)
  })

  it('is the menu of the lock while the application is locked: quitting, hiding, editing, and no entry that shows or changes what is hidden', () => {
    const app = application()
    app.lockState.appLocked = true
    app.refreshMenu()
    expect(installed.menu).toEqual(lockedMenuTemplate())
    expect(labels(installed.menu)).not.toContain(t('menu.nouvelle-fenetre'))
    expect(labels(installed.menu)).not.toContain(t('menu.nouvelle-fenetre-privee'))
    app.lockState.appLocked = false
    app.refreshMenu()
    expect(labels(installed.menu)).toContain(t('menu.nouvelle-fenetre'))
  })

  it('is rebuilt only when what it shows changed: the same lock twice installs nothing', () => {
    const app = application()
    installed.menu = null
    app.refreshMenu()
    expect(installed.menu).toBeNull()
    app.lockState.appLocked = true
    app.refreshMenu()
    expect(installed.menu).not.toBeNull()
  })

  it('greys out « Nouveau dossier » while the space on screen is locked alone, and gives it back once it is unlocked', () => {
    const app = application()
    const newFolder = (): Item | undefined => (installed.menu ?? []).flatMap((item) => item.submenu ?? []).find((item) => item.label === t('menu.nouveau-dossier'))
    expect(newFolder()?.enabled).toBe(true)
    app.lockState.spaces = [app.state.activeSpaceId]
    app.refreshMenu()
    expect(newFolder()).toMatchObject({ enabled: false, toolTip: t('lock.deverrouillez-l-espace-d-abord') })
    app.lockState.spaces = []
    app.refreshMenu()
    expect(newFolder()?.enabled).toBe(true)
  })

  it('greys out « Exporter cet espace… » while the space on screen is locked, with the reason, and gives it back once it is unlocked', () => {
    const app = application()
    const exportEntry = (): Item | undefined => (installed.menu ?? []).flatMap((item) => item.submenu ?? []).find((item) => item.label === t('space-transfer.exporter-cet-espace'))
    expect(exportEntry()?.enabled).toBe(true)
    app.lockState.spaces = [app.state.activeSpaceId]
    app.refreshMenu()
    expect(exportEntry()).toMatchObject({ enabled: false, toolTip: t('lock.deverrouillez-l-espace-d-abord') })
    app.lockState.spaces = []
    app.refreshMenu()
    expect(exportEntry()?.enabled).toBe(true)
  })

  // The menu is built from the state the interface is given, not from the real one (shell/lock-state.ts), and rebuilt when a space is locked or unlocked.
  it('is built from what the lock shows: the archive of a locked space is not there for « Rouvrir le dernier onglet fermé »', () => {
    const app = application()
    const reopen = (): Item | undefined => (installed.menu ?? []).flatMap((item) => item.submenu ?? []).find((item) => item.label === t('menu.rouvrir-le-dernier-onglet-ferme'))
    expect(reopen()?.enabled).toBe(true)
    app.lockState.spaces = [app.state.activeSpaceId]
    app.refreshMenu()
    expect(reopen()?.enabled).toBe(false)
    app.lockState.spaces = []
    app.refreshMenu()
    expect(reopen()?.enabled).toBe(true)
  })

  it('is rebuilt when a space is locked or unlocked, and when the lock is switched on or off in the settings', () => {
    const app = application()
    const rebuilt = (change: () => void): boolean => {
      installed.menu = null
      change()
      app.refreshMenu()
      return installed.menu !== null
    }
    // A space that hides nothing from the menu is locked: the lock itself is part of what the menu shows (the entries it greys out).
    expect(rebuilt(() => (app.lockState.spaces = ['a-space-with-nothing-in-it']))).toBe(true)
    expect(rebuilt(() => (app.lockState.spaces = [app.state.activeSpaceId]))).toBe(true)
    expect(rebuilt(() => (app.lockState.spaces = []))).toBe(true)
    expect(rebuilt(() => undefined)).toBe(false)
    expect(rebuilt(() => (app.lockState.active = false))).toBe(true)
  })

  it('is not rebuilt for what the lock hides: emptying the archive of a locked space changes nothing the menu shows', () => {
    const app = application()
    app.lockState.spaces = [app.state.activeSpaceId]
    app.refreshMenu()
    installed.menu = null
    app.state.archive.length = 0
    app.refreshMenu()
    expect(installed.menu).toBeNull()
    // The same archive in a space that is not locked is what the menu shows: emptying it rebuilds the menu.
    app.lockState.spaces = []
    app.state.archive.push({ id: 'closed-again', spaceId: app.state.activeSpaceId, url: 'https://secret.example/', title: 'Secret', archivedAt: 3 })
    app.refreshMenu()
    installed.menu = null
    app.state.archive.length = 0
    app.refreshMenu()
    expect(installed.menu).not.toBeNull()
  })
})
