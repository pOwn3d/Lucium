// The menu bar when what it shows changes while it is being built, as `installAppMenus` really installs it (real state, over a fake Electron that keeps
// what it is given). The menu is rebuilt only when its key changed: a change that arrives between the moment a menu is read from the state and the moment
// it is installed must not leave that older menu in place with the newer key recorded as shown (the entry « Rouvrir le dernier onglet fermé » stayed
// greyed out after ⌘W until something else changed the key: the end-to-end test of ⇧⌘T failed on Windows that way).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import { selectionOf } from '@shared/window-selection'

interface Item {
  label?: string
  enabled?: boolean
  submenu?: Item[]
}

/** What Electron was last given as the application menu, how many menus it was given, and what runs while a menu is built (the template is already read). */
const electron = vi.hoisted(() => ({ menu: null as Item[] | null, installs: 0, whileBuilding: null as (() => void) | null }))

vi.mock('electron', async () => {
  const base = (await import('./ipc-fake.test-support')).fakeElectron() as Record<string, unknown>
  const own: Record<string, unknown> = {
    Menu: {
      buildFromTemplate: (template: Item[]) => {
        const run = electron.whileBuilding
        electron.whileBuilding = null
        run?.()
        return template
      },
      setApplicationMenu: (menu: Item[]) => {
        electron.menu = menu
        electron.installs++
      }
    },
    app: { dock: undefined, getLocale: () => 'fr-FR', getVersion: () => '0.3.0', getName: () => 'Lucium', getPath: () => '/tmp/lucium-test', isDefaultProtocolClient: () => false, isPackaged: false, setAboutPanelOptions: () => {} }
  }
  return new Proxy(own, { has: (target, prop) => prop in target || prop in base, get: (target, prop: string) => (prop in target ? target[prop] : base[prop]) })
})
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))

const { installAppMenus } = await import('./app-menu-wiring')
const { StateStore, WindowView } = await import('../store')

/** The application with one window over a real state; `facts.loading` is a fact of the page that the key of the menu holds. */
function application() {
  let counter = 0
  const shared = new StateStore(createInitialState({ now: 0, newId: () => `id${++counter}` }), null)
  const view = new WindowView(shared, selectionOf(shared.get()), new Set(), true)
  const facts = { canGoBack: false, canGoForward: false, loading: false, finding: false, sound: 'silent' as const }
  const browser = new Proxy({ menuFacts: () => ({ ...facts }) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) })
  const target = { id: 'main', kind: 'main', win: { isDestroyed: () => false, isAlwaysOnTop: () => false }, store: view, browser }
  const windowManager = { focused: () => target, isMainAway: () => false, namesKey: () => '', closedCount: () => 0, canReopenClosed: () => false, reopenClosed: () => null, entries: () => [], onChange: () => () => {} }
  const lock = { isAppLocked: () => false, isActive: () => false, lockedSpaces: () => [] as string[], view: () => ({ active: false, appLocked: false, lockedSpaces: [], guardedSpaces: [], touchId: false, retryInMs: 0 }), lockNow: () => {} }
  const little = { count: () => 0, onCountChange: () => {}, showAll: () => {}, closeAll: () => {} }
  const engine = { listExtensions: () => [], onExtensionsChanged: () => {}, info: () => ({ name: 'Electron', version: '45', chromium: '150' }) }
  const { refreshMenu } = installAppMenus({ engine, lock, little, windowManager, store: view, browser, annotateShare: null, pageAnnotate: null, aboutWindow: { open: () => {} }, taskManager: { open: () => {} }, sessionStart: 0 } as never)
  return { view, facts, refreshMenu }
}

/** File › « Rouvrir le dernier onglet fermé » in the menu Electron holds. */
const reopen = (): Item | undefined => (electron.menu ?? []).flatMap((item) => item.submenu ?? []).find((item) => item.label === t('menu.rouvrir-le-dernier-onglet-ferme'))

beforeEach(() => {
  electron.menu = null
  electron.installs = 0
  electron.whileBuilding = null
})

describe('the menu bar when the state changes while it is being built', () => {
  it('follows a tab archived once the menu is read and before it is installed: « Rouvrir le dernier onglet fermé » is not left greyed out', () => {
    const app = application()
    expect(reopen()?.enabled).toBe(false)
    // The page loaded: the menu is rebuilt (the key holds `hasTabs`), and while it is, the tab is archived (⌘W).
    app.view.dispatch({ type: 'tab/open', url: 'http://127.0.0.1/b' })
    const tab = app.view.get().tabs[0]!
    electron.whileBuilding = () => app.view.dispatch({ type: 'tab/archive', id: tab.id })
    app.facts.loading = true
    app.refreshMenu()
    expect(app.view.get().archive).toHaveLength(1)
    expect(reopen()?.enabled).toBe(true)
  })

  it('does not rebuild again when what changed meanwhile leaves the key as it was', () => {
    const app = application()
    app.facts.loading = true
    electron.installs = 0
    electron.whileBuilding = () => app.refreshMenu()
    app.refreshMenu()
    expect(electron.installs).toBe(1)
  })

  it('gives up after a few passes when every build changes the state again, and the next change heals it', () => {
    const app = application()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const restless = (): void => {
      app.facts.loading = !app.facts.loading
      electron.whileBuilding = restless
      app.refreshMenu()
    }
    electron.installs = 0
    restless()
    expect(electron.installs).toBeGreaterThan(1)
    expect(electron.installs).toBeLessThan(10)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[menu]'))
    // The next change of the state finds the menu behind and builds it again.
    electron.whileBuilding = null
    electron.installs = 0
    app.refreshMenu()
    expect(electron.installs).toBe(1)
    warn.mockRestore()
  })
})
